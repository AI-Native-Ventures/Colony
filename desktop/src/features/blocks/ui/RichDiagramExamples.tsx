import { DiagramPreview } from "@/shared/ui/diagram-preview/DiagramPreview";
import { DIAGRAM_EXAMPLES } from "@/shared/ui/diagram-preview/diagramExamples";

/** Complex examples expose layout, branches, long labels and theme behavior. */
export function RichDiagramExamples() {
  return (
    <div className="space-y-8">
      {DIAGRAM_EXAMPLES.map((example) => (
        <section
          className="min-w-0 space-y-3"
          data-testid={`rich-preview-example-diagram-${example.id}`}
          key={example.id}
        >
          <p className="text-sm text-muted-foreground">{example.subtitle}</p>
          <DiagramPreview
            filename={`diagram-${example.id}.mmd`}
            source={example.source}
            title={example.title}
          />
          <p className="text-xs text-muted-foreground">{example.footer}</p>
        </section>
      ))}
    </div>
  );
}
