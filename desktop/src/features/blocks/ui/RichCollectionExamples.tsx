import { MediaCollection } from "@/shared/ui/media-preview/MediaCollection";
import type {
  MediaCollectionEntry,
  MediaCollectionItem,
} from "@/shared/ui/media-preview/mediaCollectionModel";

function file(
  source: string,
  filename: string,
  kind: MediaCollectionItem["kind"] = "file",
  mime?: string,
): MediaCollectionEntry {
  const url = `/rich-previews/${source}`;
  return {
    item: {
      src: url,
      originalUrl: url,
      downloadUrl: url,
      filename,
      kind,
      mime,
      ...(kind === "video"
        ? { poster: "/rich-previews/preview-video-poster.jpg" }
        : {}),
      ...(kind === "image" ? { width: 1080, height: 1080, alt: filename } : {}),
    },
  };
}
const report = file(
  "service-report.pdf",
  "campaign-report.pdf",
  "file",
  "application/pdf",
);
const collections = [
  {
    id: "documents",
    title: "A reading pack",
    description:
      "Choose a document. Your page and sheet are retained while you browse this collection.",
    entries: [
      report,
      file("service-report.pdf", "client-brief.pdf", "file", "application/pdf"),
      file("service-ledger.xlsx", "service-ledger.xlsx"),
      file("service-ledger.csv", "service-ledger.csv"),
    ],
  },
  {
    id: "videos",
    title: "Two cuts to review",
    description:
      "One player at a time. These sample cuts use the same clip to demonstrate switching.",
    entries: [
      file("preview-video.mp4", "launch-cut-a.mp4", "video"),
      file("preview-video.mp4", "launch-cut-b.mp4", "video"),
    ],
  },
  {
    id: "mixed",
    title: "Everything for the launch",
    description:
      "Images, documents, video and audio keep their order in one message. Unavailable files remain visible.",
    entries: [
      file("launch-01.svg", "campaign-cover.svg", "image"),
      report,
      file("preview-video.mp4", "launch-video.mp4", "video"),
      file("preview-audio.wav", "narration.wav", "audio"),
      {
        reason:
          "This attachment is unavailable. Ask the sender to attach it again.",
      },
    ],
  },
] satisfies Array<{
  id: string;
  title: string;
  description: string;
  entries: MediaCollectionEntry[];
}>;

/** Ordered file examples use real bundled viewers without mounting every file. */
export function RichCollectionExamples() {
  return (
    <div className="space-y-8">
      {collections.map((collection) => (
        <section
          className="min-w-0 space-y-3"
          data-testid={`rich-preview-example-collection-${collection.id}`}
          key={collection.id}
        >
          <h3 className="text-sm font-medium">{collection.title}</h3>
          <p className="text-sm text-muted-foreground">
            {collection.description}
          </p>
          <MediaCollection
            entries={collection.entries}
            title={collection.title}
          />
        </section>
      ))}
    </div>
  );
}
