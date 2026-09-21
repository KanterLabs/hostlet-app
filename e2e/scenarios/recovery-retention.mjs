import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  throw new Error(`recovery retention expectation failed: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactIds(actual, expected, label) {
  requireCondition(Array.isArray(actual), `${label} must be an array`);
  requireCondition(actual.every((value) => typeof value === "string" && UUID_PATTERN.test(value)), `${label} contains an invalid backup ID`);
  const actualSorted = sorted(new Set(actual));
  const expectedSorted = sorted(new Set(expected));
  requireCondition(actual.length === actualSorted.length, `${label} contains duplicate backup IDs`);
  requireCondition(
    actualSorted.length === expectedSorted.length &&
      actualSorted.every((value, index) => value === expectedSorted[index]),
    `${label} did not match the independently calculated backup IDs`,
  );
}

function asDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  requireCondition(Number.isFinite(date.getTime()), `${label} must be a valid RFC3339 timestamp`);
  return date;
}

function offsetDate(base, hours) {
  return new Date(base.getTime() - hours * HOUR_MS);
}

function receiptRecord(receipt, expectedScheduledFor, startedAt, finishedAt) {
  const manifest = receipt?.manifest;
  requireCondition(manifest && typeof manifest === "object", "scheduled backup did not return a manifest");
  requireCondition(typeof manifest.backup_id === "string" && UUID_PATTERN.test(manifest.backup_id), "scheduled backup returned an invalid backup ID");
  const scheduledFor = asDate(manifest.scheduled_for, "scheduled_for");
  requireCondition(scheduledFor.getTime() === expectedScheduledFor.getTime(), "scheduled backup returned the wrong UTC schedule time");
  requireCondition(typeof manifest.source_target_fingerprint === "string" && manifest.source_target_fingerprint.length > 0, "scheduled receipt omitted the source target fingerprint");
  requireCondition(typeof manifest.recovery_key_id === "string" && manifest.recovery_key_id.length > 0, "scheduled receipt omitted the recovery key identifier");

  const snapshotAt = asDate(manifest.snapshot_at, "snapshot_at");
  requireCondition(
    snapshotAt.getTime() >= startedAt - 5_000 && snapshotAt.getTime() <= finishedAt + 5_000,
    "accelerated schedule time was used as the real dump timestamp",
  );
  return {
    id: manifest.backup_id,
    scheduledFor,
    snapshotAt,
  };
}

// This is deliberately an E2E-side oracle. It uses only timestamps returned by
// the CLI and expresses the documented UTC windows without importing production
// retention code or relying on fixture result counts. Daily recovery points
// use completed UTC calendar dates, so a point cannot change windows as the
// hourly cutoff advances.
function expectedRetention(records, effectiveAt) {
  const hourlyCutoff = new Date(effectiveAt.getTime() - 48 * HOUR_MS);
  const cutoffDateStart = Date.UTC(
    hourlyCutoff.getUTCFullYear(),
    hourlyCutoff.getUTCMonth(),
    hourlyCutoff.getUTCDate(),
  );
  const keep = new Set();

  for (const record of records) {
    if (record.scheduledFor === null) {
      keep.add(record.id);
      continue;
    }
    requireCondition(record.scheduledFor.getTime() <= effectiveAt.getTime(), "scheduler returned a future recovery point");
    if (record.scheduledFor.getTime() >= hourlyCutoff.getTime()) keep.add(record.id);
  }

  for (let completedDate = 1; completedDate <= 7; completedDate += 1) {
    const upper = new Date(cutoffDateStart - (completedDate - 1) * DAY_MS);
    const lower = new Date(upper.getTime() - DAY_MS);
    const candidates = records
      .filter(
        ({ scheduledFor }) =>
          scheduledFor !== null &&
          scheduledFor.getTime() >= lower.getTime() &&
          scheduledFor.getTime() < upper.getTime(),
      )
      .sort((left, right) => right.scheduledFor.getTime() - left.scheduledFor.getTime());
    if (candidates[0]) keep.add(candidates[0].id);
  }

  return {
    kept: records.filter(({ id }) => keep.has(id)),
    deleted: records.filter(({ id }) => !keep.has(id)),
  };
}

async function repositoryInventory(repository) {
  const entries = await readdir(repository, { withFileTypes: true });
  const backupIds = [];
  const receiptIds = [];
  for (const entry of entries) {
    const backupMatch = entry.name.match(/^([0-9a-f-]{36})\.hostlet-backup$/i);
    const receiptMatch = entry.name.match(/^([0-9a-f-]{36})\.receipt\.json$/i);
    if (backupMatch && UUID_PATTERN.test(backupMatch[1])) backupIds.push(backupMatch[1]);
    if (receiptMatch && UUID_PATTERN.test(receiptMatch[1])) receiptIds.push(receiptMatch[1]);
  }
  return {
    names: sorted(entries.map(({ name }) => name)),
    backupIds: sorted(backupIds),
    receiptIds: sorted(receiptIds),
  };
}

async function assertRegularPair(repository, backupId) {
  const backup = await lstat(join(repository, `${backupId}.hostlet-backup`));
  const receipt = await lstat(join(repository, `${backupId}.receipt.json`));
  requireCondition(backup.isFile() && !backup.isSymbolicLink(), "retained backup artifact is not a regular file");
  requireCondition(receipt.isFile() && !receipt.isSymbolicLink(), "retained backup receipt is not a regular file");
}

function sameNames(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertReceiptsDoNotExposeCredentialFields(repository, backupIds) {
  for (const backupId of backupIds) {
    const receipt = await readFile(join(repository, `${backupId}.receipt.json`), "utf8");
    const parsed = JSON.parse(receipt);
    const pending = [parsed];
    while (pending.length > 0) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      for (const [name, child] of Object.entries(value)) {
        requireCondition(
          !["database_url", "password", "credential", "recovery_key", "secret_key"].includes(name),
          "a backup receipt retained a plaintext credential field",
        );
        pending.push(child);
      }
    }
  }
}

export async function runRetentionScenarios({
  context,
  repository,
  manualBackupIds,
  runCli,
  effectiveBase,
  fixture,
}) {
  requireCondition(typeof repository === "string" && repository.length > 0, "repository is required");
  requireCondition(Array.isArray(manualBackupIds) && manualBackupIds.length > 0, "manual backup IDs are required");
  requireCondition(manualBackupIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id)), "manual backup ID is invalid");
  requireCondition(new Set(manualBackupIds).size === manualBackupIds.length, "manual backup IDs must be unique");
  requireCondition(typeof runCli === "function", "runCli is required");

  const base = asDate(effectiveBase, "effectiveBase");
  requireCondition(
    base.getUTCHours() === 0 &&
      base.getUTCMinutes() === 0 &&
      base.getUTCSeconds() === 0 &&
      base.getUTCMilliseconds() === 0,
    "effectiveBase must be a UTC midnight boundary",
  );
  const retention = fixture?.retention;
  requireCondition(Array.isArray(retention?.hourly_offsets), "hourly retention offsets are required");
  requireCondition(Array.isArray(retention?.daily_offsets), "daily retention offsets are required");
  requireCondition(Number.isInteger(retention?.expired_offset), "expired retention offset is required");
  requireCondition(
    retention.hourly_offsets.length === 49 &&
      retention.hourly_offsets.includes(48) &&
      retention.hourly_offsets.includes(0) &&
      new Set(retention.hourly_offsets).size === 49,
    "fixture must cover each recovery point in the inclusive 48-hour window",
  );
  requireCondition(retention.daily_offsets.length === 7 && new Set(retention.daily_offsets).size === 7, "fixture must cover seven preceding daily windows");

  const initialInventory = await repositoryInventory(repository);
  assertExactIds(initialInventory.backupIds, manualBackupIds, "initial backup artifacts");
  assertExactIds(initialInventory.receiptIds, manualBackupIds, "initial backup receipts");
  for (const id of manualBackupIds) await assertRegularPair(repository, id);

  const manualRecords = [];
  for (const id of manualBackupIds) {
    const result = await runCli(
      "verify manual recovery point before scheduled retention",
      ["backup", "verify", "--repository", repository, "--backup-id", id],
    );
    requireCondition(result?.code === 0, "manual recovery point verification failed");
    requireCondition(result.payload?.manifest?.backup_id === id, "manual verification returned the wrong backup receipt");
    requireCondition(result.payload.manifest.scheduled_for === null, "manual recovery point unexpectedly has a schedule timestamp");
    manualRecords.push({ id, scheduledFor: null, snapshotAt: asDate(result.payload.manifest.snapshot_at, "manual snapshot_at") });
  }

  const extraDailyOffset = Math.min(...retention.daily_offsets) + 1;
  requireCondition(!retention.daily_offsets.includes(extraDailyOffset), "extra daily-window candidate must have a unique schedule hour");
  const offsets = [
    retention.expired_offset,
    ...retention.daily_offsets,
    extraDailyOffset,
    ...retention.hourly_offsets,
  ];
  requireCondition(new Set(offsets).size === offsets.length, "retention schedule offsets must be unique");
  const schedule = offsets
    .map((offset) => ({ offset, effectiveAt: offsetDate(base, offset) }))
    .sort((left, right) => left.effectiveAt.getTime() - right.effectiveAt.getTime());

  const allScheduledRecords = [];
  let liveRecords = [...manualRecords];
  const deletedIds = new Set();
  let lastOutcome;

  for (const point of schedule) {
    const startedAt = Date.now();
    const result = await runCli(
      `scheduled recovery point ${point.offset} hours before the retention anchor`,
      ["backup", "schedule", "--repository", repository, "--effective-at", point.effectiveAt.toISOString()],
    );
    const finishedAt = Date.now();
    requireCondition(result?.code === 0, "scheduled backup command failed");
    requireCondition(result.payload?.created, "a unique UTC schedule hour did not create a backup");
    const created = receiptRecord(result.payload.created, point.effectiveAt, startedAt, finishedAt);
    requireCondition(!allScheduledRecords.some(({ id }) => id === created.id), "scheduler reused a backup ID");
    allScheduledRecords.push(created);

    const candidates = [...liveRecords, created];
    const oracle = expectedRetention(candidates, point.effectiveAt);
    assertExactIds(result.payload?.retention?.kept, oracle.kept.map(({ id }) => id), "scheduler kept set");
    assertExactIds(result.payload?.retention?.deleted, oracle.deleted.map(({ id }) => id), "scheduler deleted set");
    for (const { id } of oracle.deleted) deletedIds.add(id);
    liveRecords = oracle.kept;
    requireCondition(manualBackupIds.every((id) => liveRecords.some((record) => record.id === id)), "scheduled progression deleted a manual backup");
    lastOutcome = result.payload;
  }

  const finalOracle = expectedRetention([...manualRecords, ...allScheduledRecords], base);
  assertExactIds(liveRecords.map(({ id }) => id), finalOracle.kept.map(({ id }) => id), "final independently retained set");
  assertExactIds(lastOutcome?.retention?.kept, finalOracle.kept.map(({ id }) => id), "final CLI retained set");
  assertExactIds([...deletedIds], finalOracle.deleted.map(({ id }) => id), "cumulative CLI deleted set");

  const hourlyKept = finalOracle.kept.filter(
    ({ scheduledFor }) => scheduledFor && scheduledFor.getTime() >= base.getTime() - 48 * HOUR_MS,
  );
  requireCondition(hourlyKept.length === 49, "final policy did not keep all 49 inclusive hourly recovery points");
  const cutoffRecord = allScheduledRecords.find(
    ({ scheduledFor }) => scheduledFor.getTime() === offsetDate(base, 48).getTime(),
  );
  requireCondition(
    cutoffRecord && finalOracle.kept.some(({ id }) => id === cutoffRecord.id),
    "the recovery point exactly on the 48-hour cutoff was not retained",
  );
  const dailyKept = finalOracle.kept.filter(
    ({ scheduledFor }) => scheduledFor && scheduledFor.getTime() < base.getTime() - 48 * HOUR_MS,
  );
  requireCondition(dailyKept.length === 7, "final policy did not keep one recovery point in each daily window");
  const extraRecord = allScheduledRecords.find(({ scheduledFor }) => scheduledFor.getTime() === offsetDate(base, extraDailyOffset).getTime());
  requireCondition(extraRecord && finalOracle.deleted.some(({ id }) => id === extraRecord.id), "newest-per-window selection did not delete the extra older candidate");
  const expiredRecord = allScheduledRecords.find(({ scheduledFor }) => scheduledFor.getTime() === offsetDate(base, retention.expired_offset).getTime());
  requireCondition(expiredRecord && finalOracle.deleted.some(({ id }) => id === expiredRecord.id), "expired recovery point was not deleted");

  const finalIds = finalOracle.kept.map(({ id }) => id);
  const finalInventory = await repositoryInventory(repository);
  assertExactIds(finalInventory.backupIds, finalIds, "final backup artifact files");
  assertExactIds(finalInventory.receiptIds, finalIds, "final backup receipt files");
  requireCondition(initialInventory.names.every((name) => finalInventory.names.includes(name)), "scheduler removed an initial repository file");
  for (const id of finalIds) await assertRegularPair(repository, id);

  for (const record of finalOracle.kept) {
    const result = await runCli(
      "verify retained recovery point",
      ["backup", "verify", "--repository", repository, "--backup-id", record.id],
    );
    requireCondition(result?.code === 0, "retained recovery point verification failed");
    requireCondition(result.payload?.manifest?.backup_id === record.id, "verification returned the wrong backup receipt");
    requireCondition(
      record.scheduledFor === null
        ? result.payload.manifest.scheduled_for === null
        : asDate(result.payload.manifest.scheduled_for, "verified scheduled_for").getTime() === record.scheduledFor.getTime(),
      "verification returned the wrong scheduling metadata",
    );
  }
  await assertReceiptsDoNotExposeCredentialFields(repository, finalIds);

  const beforeDedupe = await repositoryInventory(repository);
  const dedupe = await runCli(
    "same-hour scheduled backup deduplication",
    ["backup", "schedule", "--repository", repository, "--effective-at", base.toISOString()],
  );
  requireCondition(dedupe?.code === 0 && dedupe.payload?.created === null, "same-hour schedule created another backup");
  assertExactIds(dedupe.payload?.retention?.kept, finalIds, "same-hour dedupe kept set");
  assertExactIds(dedupe.payload?.retention?.deleted, [], "same-hour dedupe deleted set");
  const afterDedupe = await repositoryInventory(repository);
  requireCondition(sameNames(beforeDedupe.names, afterDedupe.names), "same-hour dedupe changed repository files");

  const ownedFixture = finalOracle.kept.find(({ scheduledFor }) => scheduledFor !== null);
  requireCondition(ownedFixture, "no owned scheduled fixture remained for fail-closed checks");
  const ownedReceiptPath = join(repository, `${ownedFixture.id}.receipt.json`);
  const ownedBackupPath = join(repository, `${ownedFixture.id}.hostlet-backup`);
  const originalReceipt = await readFile(ownedReceiptPath);
  const originalBackup = await readFile(ownedBackupPath);
  let corruptRestore = { path: ownedReceiptPath, bytes: originalReceipt };
  let activeSwap = null;
  const receiptSentinelPath = join(context.tempDir, `retention-receipt-sentinel-${randomUUID()}`);
  const backupSentinelPath = join(context.tempDir, `retention-backup-sentinel-${randomUUID()}`);
  const sentinelPaths = [receiptSentinelPath, backupSentinelPath];
  const cleanup = async () => {
    if (activeSwap) {
      try {
        await unlink(activeSwap.exposed);
      } catch {}
      try {
        await rename(activeSwap.stash, activeSwap.exposed);
      } catch {}
      activeSwap = null;
    }
    if (corruptRestore) {
      try {
        await writeFile(corruptRestore.path, corruptRestore.bytes);
      } catch {}
      corruptRestore = null;
    }
    for (const sentinelPath of sentinelPaths) {
      try {
        await unlink(sentinelPath);
      } catch {}
    }
  };
  context.registerCleanup("restore owned recovery retention safety fixtures", cleanup);

  const beforeCorruption = await repositoryInventory(repository);
  try {
    await writeFile(ownedReceiptPath, '{"invalid":"e2e-owned-corrupt-receipt"}\n', "utf8");
    const refused = await runCli(
      "scheduler refuses corrupt owned receipt",
      ["backup", "schedule", "--repository", repository, "--effective-at", offsetDate(base, -1).toISOString()],
      { allowFailure: true, expectedErrorCode: "backup_receipt_invalid" },
    );
    requireCondition(refused?.code !== 0, "scheduler accepted a corrupt receipt");
    const afterRefusal = await repositoryInventory(repository);
    assertExactIds(afterRefusal.backupIds, beforeCorruption.backupIds, "corrupt-receipt refusal backup files");
    assertExactIds(afterRefusal.receiptIds, beforeCorruption.receiptIds, "corrupt-receipt refusal receipt files");
  } finally {
    await writeFile(ownedReceiptPath, originalReceipt);
    corruptRestore = null;
  }
  requireCondition((await readFile(ownedReceiptPath)).equals(originalReceipt), "corrupt receipt fixture was not restored byte-for-byte");

  await writeFile(receiptSentinelPath, originalReceipt, { mode: 0o600, flag: "wx" });
  await writeFile(backupSentinelPath, originalBackup, { mode: 0o600, flag: "wx" });
  const exerciseSymlinkRefusal = async (kind, exposed, sentinelPath, sentinelBytes, expectedErrorCode) => {
    const before = await repositoryInventory(repository);
    const stash = join(repository, `.e2e-retention-${kind}-${ownedFixture.id}-${randomUUID()}`);
    await rename(exposed, stash);
    activeSwap = { exposed, stash };
    try {
      await symlink(sentinelPath, exposed);
      const refused = await runCli(
        `scheduler refuses symlink ${kind}`,
        ["backup", "schedule", "--repository", repository, "--effective-at", offsetDate(base, -1).toISOString()],
        { allowFailure: true, expectedErrorCode },
      );
      requireCondition(refused?.code !== 0, `scheduler accepted a symlink ${kind}`);
      const during = await repositoryInventory(repository);
      assertExactIds(during.backupIds, before.backupIds, `symlink ${kind} refusal backup files`);
      assertExactIds(during.receiptIds, before.receiptIds, `symlink ${kind} refusal receipt files`);
      requireCondition((await readFile(sentinelPath)).equals(sentinelBytes), `symlink ${kind} refusal changed the outside sentinel`);
    } finally {
      try {
        await unlink(exposed);
      } catch {}
      await rename(stash, exposed);
      activeSwap = null;
    }
    const after = await repositoryInventory(repository);
    requireCondition(sameNames(before.names, after.names), `symlink ${kind} fixture was not restored exactly`);
    requireCondition((await readFile(sentinelPath)).equals(sentinelBytes), `symlink ${kind} check did not preserve the outside sentinel`);
  };

  await exerciseSymlinkRefusal(
    "receipt",
    ownedReceiptPath,
    receiptSentinelPath,
    originalReceipt,
    "backup_receipt_invalid",
  );
  await exerciseSymlinkRefusal(
    "artifact",
    ownedBackupPath,
    backupSentinelPath,
    originalBackup,
    "backup_artifact_invalid",
  );
  for (const sentinelPath of sentinelPaths) await unlink(sentinelPath);

  const afterSafetyChecks = await repositoryInventory(repository);
  assertExactIds(afterSafetyChecks.backupIds, finalIds, "post-safety-check backup files");
  assertExactIds(afterSafetyChecks.receiptIds, finalIds, "post-safety-check receipt files");
  for (const id of manualBackupIds) await assertRegularPair(repository, id);

  return {
    accelerated_clock: true,
    real_dump_timestamps_observed: allScheduledRecords.length,
    scheduled_created: allScheduledRecords.length,
    scheduled_kept: finalOracle.kept.length - manualBackupIds.length,
    scheduled_deleted: finalOracle.deleted.length,
    manual_kept: manualBackupIds.length,
    same_hour_created: false,
    same_hour_kept: dedupe.payload.retention.kept.length,
    same_hour_deleted: dedupe.payload.retention.deleted.length,
    corruption_refused_without_deletion: true,
    symlink_receipt_refused_and_sentinel_preserved: true,
    symlink_backup_refused_and_sentinel_preserved: true,
    credential_fields_in_receipts: 0,
  };
}
