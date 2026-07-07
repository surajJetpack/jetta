import { gate } from "@/lib/console-auth";
import { Nav, Locked } from "../../nav";
import { KbNav } from "../kb-nav";
import KbArticle from "../kb-article";

export const dynamic = "force-dynamic";

export default async function ArticlePage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; id?: string }>;
}) {
  const params = await searchParams;
  const { locked, adminKey } = await gate(Promise.resolve(params));
  if (locked) return <Locked />;
  return (
    <div className="wrap">
      <Nav current="kb" adminKey={adminKey} />
      <KbNav current="list" adminKey={adminKey} />
      <KbArticle adminKey={adminKey} id={params.id} />
    </div>
  );
}
