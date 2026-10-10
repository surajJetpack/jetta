"use client";

import { useRef } from "react";
import TrialsDiscountsQueue from "./billing-queue";
import BillingHistory from "./billing-history";

/** Pending queue on top, decision history below; a decision refreshes both. */
export default function BillingPanel({
  freshdeskDomain,
  writesEnabled,
}: {
  freshdeskDomain: string;
  writesEnabled: boolean;
}) {
  const reloadHistory = useRef<(() => void) | null>(null);
  return (
    <div className="grid min-w-0 gap-5">
      <TrialsDiscountsQueue
        freshdeskDomain={freshdeskDomain}
        writesEnabled={writesEnabled}
        onDecided={() => reloadHistory.current?.()}
      />
      <BillingHistory freshdeskDomain={freshdeskDomain} reloadRef={reloadHistory} />
    </div>
  );
}
