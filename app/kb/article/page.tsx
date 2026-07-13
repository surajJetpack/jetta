import { redirect } from "next/navigation";
import { gate } from "@/lib/console-auth";
import { Nav } from "../../nav";
import { KbNav } from "../kb-nav";
import KbArticle from "../kb-article";

export const dynamic = "force-dynamic";

export default async function ArticlePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const { locked, user } = await gate();
  if (locked) {
    redirect(`/login?next=${encodeURIComponent(id ? `/kb/article?id=${id}` : "/kb")}`);
  }
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-5 pt-8 pb-20">
      <Nav current="kb" user={user} />
      <KbNav current="list" />
      <KbArticle id={id} />
    </div>
  );
}
