import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";

type Props = {
  code: string;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  onContinue: () => void;
};

export function RecoveryScreen({
  code,
  acknowledged,
  onAcknowledge,
  onContinue,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard access can be denied. Selecting the text still works, so
      // the label change is the only feedback that matters here.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const save = () => {
    const blob = new Blob(
      [`Colony recovery code\n\n${code}\n\nKeep this somewhere safe.\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "colony-recovery-code.txt";
    anchor.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Keep this code somewhere safe.</h1>
        <p className="onb-sub">
          If you ever forget your password, this code is the only way back into
          your account. We cannot reset it for you.
        </p>
      </div>
      <div className="onb-panel">
        <p className="onb-code">{code}</p>
        <div className="onb-row">
          <Button variant="outline" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" onClick={save}>
            {saved ? "Saved" : "Save as file"}
          </Button>
        </div>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the custom Checkbox renders a native control inside this label, so association holds in the rendered DOM. */}
        <label className="onb-check">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(value) => onAcknowledge(value === true)}
          />
          <span className="onb-label">I have saved my code</span>
        </label>
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!acknowledged} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
