"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Shared markdown renderer — styling comes from the `.md` block in globals.css. */
export function Md({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
