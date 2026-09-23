export async function GET() { return Response.json({ status: "ok", release_id: "next16-v1", runtime: process.versions.node }); }
