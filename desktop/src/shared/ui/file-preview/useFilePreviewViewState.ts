import * as React from "react";

/** Lightweight navigation retained while a file's loaded preview is unmounted. */
export type FilePreviewViewState = {
  sheet: number;
  rowPages: Record<number, number>;
  page: number;
  zoom: number;
};

type NavigationField = "sheet" | "rowPage" | "page" | "zoom";

/** Restore navigation once on mount and report user changes before a parent can unmount it. */
export function useFilePreviewViewState(
  initialViewState?: FilePreviewViewState,
  onViewStateChange?: (state: FilePreviewViewState) => void,
) {
  const [viewState, setViewState] = React.useState<FilePreviewViewState>(
    () => ({
      sheet: initialViewState?.sheet ?? 0,
      rowPages: { ...initialViewState?.rowPages },
      page: initialViewState?.page ?? 1,
      zoom: initialViewState?.zoom ?? 1,
    }),
  );
  const current = React.useRef(viewState);
  const changeViewState = React.useCallback(
    (field: NavigationField, value: number) => {
      const previous = current.current;
      const oldValue =
        field === "rowPage"
          ? previous.rowPages[previous.sheet] || 0
          : previous[field];
      if (oldValue === value) return;
      const next =
        field === "rowPage"
          ? {
              ...previous,
              rowPages: { ...previous.rowPages, [previous.sheet]: value },
            }
          : { ...previous, [field]: value };
      current.current = next;
      setViewState(next);
      onViewStateChange?.(next);
    },
    [onViewStateChange],
  );
  return [viewState, changeViewState] as const;
}
