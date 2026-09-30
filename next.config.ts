import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root — there is a stray lockfile in the home directory
  // that Next.js would otherwise infer as the root.
  turbopack: {
    root: __dirname,
  },
  // The console assistant reads its own manual at runtime (lib/console-assistant.ts).
  outputFileTracingIncludes: {
    "/api/admin/assistant/*": ["./docs/**/*.md", "./JETTA-OVERVIEW.md"],
  },
};

export default nextConfig;
