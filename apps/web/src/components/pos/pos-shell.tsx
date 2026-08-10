'use client';

import * as React from 'react';

import { PageHeader } from '@/components/page-header';

import { PosModeSelector, type PosMode } from './pos-mode-selector';

interface Props {
  mode: PosMode;
  onModeChange: (mode: PosMode) => void;
  branchName: string;
  registerName: string;
  /** Left column — menu workspace. */
  workspace: React.ReactNode;
  /** Right column — the mode's order rail. */
  rail: React.ReactNode;
  /** Optional single-line context (register, waiter, external ref, table). */
  context?: React.ReactNode;
}

/**
 * The POS chrome — page header + mode selector + two-column layout with a
 * sticky right rail. Every mode composes its own workspace (usually the
 * menu picker) and rail body inside this shell.
 */
export function PosShell({ mode, onModeChange, branchName, registerName, workspace, rail, context }: Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="POS"
          description={`${branchName} · ${registerName}`}
        />
        <PosModeSelector value={mode} onChange={onModeChange} />
      </div>
      {context ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {context}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0">{workspace}</div>
        <aside className="lg:sticky lg:top-4">{rail}</aside>
      </div>
    </div>
  );
}
