export type BrowserImportResult = {
  imported: number;
  skipped: number;
  preserved: number;
  failed: number;
  status: string;
};

/** Match the site list without changing the owner's selection. */
export function filterImportSites(sites: string[], filter: string): string[] {
  const query = filter.trim().toLowerCase();
  return sites.filter((site) => site.toLowerCase().includes(query));
}

/** Select the shown sites while preserving selections outside the search. */
export function selectImportSites(
  selected: string[],
  shown: string[],
): string[] {
  return [...new Set([...selected, ...shown])];
}

/** Explain cookie counts without claiming that website authentication succeeded. */
export function describeBrowserImport(result: BrowserImportResult): {
  title: string;
  detail: string;
  nextStep: string;
} {
  const verify =
    "Open a selected website in Colony's browser to check your account. If it asks you to sign in, sign in there.";
  if (result.status === "interrupted") {
    return {
      title: "Import stopped before it finished",
      detail:
        "Some sign-in data may have been copied. The counts below show what was completed before it stopped.",
      nextStep:
        "Try importing again. Existing Colony sign-in data will be kept unless you choose to replace it.",
    };
  }
  if (result.failed > 0) {
    return {
      title:
        result.imported > 0
          ? "Some sign-in data could not be copied"
          : "No new sign-in data copied",
      detail: "Colony could not copy some of the selected browser data.",
      nextStep: verify,
    };
  }
  if (result.imported > 0) {
    return {
      title: "Sign-in data copied",
      detail:
        "The copied data is saved in this business's browser. Your accounts still need to be checked on the websites.",
      nextStep: verify,
    };
  }
  if (result.preserved > 0) {
    return {
      title: "No new sign-in data copied",
      detail:
        "Colony kept existing sign-in data for these sites because replacement was turned off. This does not tell us whether you are still signed in.",
      nextStep:
        "Open a selected website in Colony to check it. To refresh its sign-in from this browser, select that site, turn on Replace existing sign-ins, then import again.",
    };
  }
  return {
    title: "No sign-in data could be imported",
    detail:
      result.skipped > 0
        ? "The selected data was expired or could not be imported from this browser."
        : "No usable sign-in data was found for the selected sites.",
    nextStep: verify,
  };
}

/** Keep each native request within its limit, using only explicitly selected sites. */
export async function importSelectedSites({
  hosts,
  run,
  isCurrent,
  onProgress,
}: {
  hosts: string[];
  run: (hosts: string[]) => Promise<BrowserImportResult>;
  isCurrent: () => boolean;
  onProgress: (completed: number, total: number) => void;
}): Promise<BrowserImportResult> {
  const selected = [...new Set(hosts)];
  const totals: BrowserImportResult = {
    imported: 0,
    skipped: 0,
    preserved: 0,
    failed: 0,
    status: "needs-verification",
  };
  for (let offset = 0; offset < selected.length; offset += 100) {
    if (!isCurrent()) return { ...totals, status: "interrupted" };
    const batch = selected.slice(offset, offset + 100);
    try {
      const result = await run(batch);
      totals.imported += result.imported;
      totals.skipped += result.skipped;
      totals.preserved += result.preserved;
      totals.failed += result.failed;
      if (result.status === "interrupted")
        return { ...totals, status: "interrupted" };
      onProgress(offset + batch.length, selected.length);
    } catch (error) {
      // Preserve completed counts if a later batch is interrupted or rejected.
      if (offset === 0) throw error;
      return { ...totals, status: "interrupted" };
    }
  }
  return totals;
}
