/**
 * Button + AlertDialog wrapper — the single home for destructive / send
 * confirmations (replaces every native confirm()).
 */
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function ConfirmButton({
  title,
  description,
  confirmLabel,
  onConfirm,
  variant = "default",
  size,
  disabled,
  busy,
  children,
  className,
}: {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  variant?: "default" | "destructive" | "secondary" | "outline" | "ghost";
  size?: "default" | "xs" | "sm" | "lg";
  disabled?: boolean;
  busy?: boolean;
  /** The trigger button's label. */
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled || busy} className={className}>
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="whitespace-pre-line">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={variant === "destructive" ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
            onClick={() => {
              setOpen(false);
              void onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
