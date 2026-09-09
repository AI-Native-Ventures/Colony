import { AudioLines, FileText, Image, Play, Workflow } from "lucide-react";
import type { ReactNode } from "react";

import { InlineFilePreview } from "@/shared/ui/file-preview/InlineFilePreview";
import { AudioPlayer, ImagePreview } from "@/shared/ui/media-preview";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { VideoPlayer } from "@/shared/ui/VideoPlayer";
import { BlockChart } from "./primitives/BlockChart";

const FILES = "/rich-previews/";
const slides = [
  {
    file: "launch-01.svg",
    alt: "A new week. A clearer plan.",
    width: 1080,
    height: 1080,
  },
  {
    file: "launch-02.svg",
    alt: "Make room for the work that matters.",
    width: 900,
    height: 1200,
  },
  {
    file: "launch-03.svg",
    alt: "Small steps. Visible progress.",
    width: 1440,
    height: 900,
  },
].map(({ file, ...image }) => ({
  ...image,
  src: FILES + file,
  downloadUrl: FILES + file,
  filename: file,
}));

function Example({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** Real bundled content, rendered with the same viewers used in conversations. */
export function RichPreviewGallery() {
  return (
    <section
      className="@container mb-8 min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
      data-testid="rich-preview-gallery"
    >
      <div className="border-b border-border p-5">
        <p className="text-xs font-medium text-primary">
          Inside your conversations
        </p>
        <h2 className="mt-1 text-lg font-medium tracking-tight">
          See the work, right here.
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Browse a carousel, read a report, or play a clip. Expand for a closer
          look and download the original whenever you need it.
        </p>
      </div>
      <Tabs defaultValue="images" className="min-w-0">
        <div className="overflow-x-auto border-b border-border px-4 py-3">
          <TabsList
            aria-label="Preview formats"
            className="h-auto min-w-max justify-start gap-1 bg-transparent p-0"
          >
            {(
              [
                { id: "images", label: "Images", Icon: Image },
                { id: "documents", label: "Documents", Icon: FileText },
                { id: "video", label: "Video", Icon: Play },
                { id: "audio", label: "Audio", Icon: AudioLines },
                { id: "diagrams", label: "Diagrams", Icon: Workflow },
              ] as const
            ).map(({ id, label, Icon }) => (
              <TabsTrigger
                className="gap-2 px-3 py-2 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
                key={id}
                value={id}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent
          className="m-0 space-y-8 p-5"
          data-testid="rich-preview-example"
          value="images"
        >
          <Example
            title="One image"
            description="The complete image fills the available message width."
          >
            <ImagePreview items={slides.slice(0, 1)} />
          </Example>
          <Example
            title="A carousel"
            description="Browse images and SVG artwork in their original order and proportions."
          >
            <ImagePreview items={slides} title="Launch campaign" />
          </Example>
        </TabsContent>
        <TabsContent
          className="m-0 space-y-8 p-5"
          data-testid="rich-preview-example"
          value="documents"
        >
          <Example
            title="Workbook"
            description="Switch sheets and read saved cell values."
          >
            <InlineFilePreview
              filename="service-ledger.xlsx"
              href={`${FILES}service-ledger.xlsx`}
            />
          </Example>
          <Example
            title="CSV"
            description="Readable rows and columns, with the original file ready to download."
          >
            <InlineFilePreview
              filename="service-ledger.csv"
              href={`${FILES}service-ledger.csv`}
            />
          </Example>
          <Example
            title="PDF"
            description="Move through pages and expand to read comfortably."
          >
            <InlineFilePreview
              filename="service-report.pdf"
              href={`${FILES}service-report.pdf`}
            />
          </Example>
        </TabsContent>
        <TabsContent
          className="m-0 p-5"
          data-testid="rich-preview-example"
          value="video"
        >
          <Example
            title="Video"
            description="A useful poster introduces the clip. Playback keeps its original proportions."
          >
            <VideoPlayer
              src={`${FILES}preview-video.mp4`}
              downloadUrl={`${FILES}preview-video.mp4`}
              poster={`${FILES}preview-video-poster.jpg`}
              filename="preview-video.mp4"
            />
          </Example>
        </TabsContent>
        <TabsContent
          className="m-0 p-5"
          data-testid="rich-preview-example"
          value="audio"
        >
          <Example
            title="Audio"
            description="Play, pause, seek, or download the original recording."
          >
            <AudioPlayer
              src={`${FILES}preview-audio.wav`}
              downloadUrl={`${FILES}preview-audio.wav`}
              filename="preview-audio.wav"
            />
          </Example>
        </TabsContent>
        <TabsContent
          className="m-0 space-y-8 p-5"
          data-testid="rich-preview-example"
          value="diagrams"
        >
          <Example
            title="A process at a glance"
            description="Diagrams arrive as crisp, expandable SVG files."
          >
            <ImagePreview
              items={[
                {
                  src: `${FILES}delivery-flow.svg`,
                  downloadUrl: `${FILES}delivery-flow.svg`,
                  filename: "delivery-flow.svg",
                  alt: "Brief, draft, review, deliver",
                  width: 1200,
                  height: 480,
                },
              ]}
            />
          </Example>
          <Example
            title="A readable chart"
            description="A visual summary with its underlying values one click away."
          >
            <BlockChart
              title="Weekly enquiries"
              node={{
                type: "chart",
                kind: "bar",
                data_path: "/weeks",
                label_key: "label",
                value_key: "value",
              }}
              data={{
                weeks: [
                  { label: "Week 1", value: 18 },
                  { label: "Week 2", value: 26 },
                  { label: "Week 3", value: 23 },
                  { label: "Week 4", value: 35 },
                ],
              }}
            />
          </Example>
        </TabsContent>
      </Tabs>
    </section>
  );
}
