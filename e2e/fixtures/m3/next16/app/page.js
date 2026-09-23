import Image from "next/image";
import { unstable_cache } from "next/cache";
import { echoOwnedFixture } from "./actions";

const cachedRelease = unstable_cache(async () => ({ release: "next16-v1", generated: "owned-static-value" }), ["owned-release"], { revalidate: 60 });
export const dynamic = "force-dynamic";

export default async function Page() {
  const cached = await cachedRelease();
  return <main><h1>Next 16 standalone fixture</h1><p id="ssr-release">SSR {cached.release}</p><p id="cache-value">Cache {cached.generated}</p><Image src="/fixture.svg" width={64} height={64} alt="Owned fixture mark" priority /><form action={echoOwnedFixture}><input name="value" defaultValue="server-action" /><button type="submit">Run action</button></form><a href="/api/release">Release API</a></main>;
}
