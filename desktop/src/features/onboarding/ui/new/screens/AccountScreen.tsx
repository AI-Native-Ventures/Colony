import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import {
  PASSWORD_MIN,
  isEmail,
  passwordShortfall,
} from "../../../flow/validation";

export type AccountValues = {
  name: string;
  email: string;
  password: string;
  city: string;
};

export function accountReady(values: AccountValues): boolean {
  return (
    values.name.trim().length > 0 &&
    isEmail(values.email) &&
    passwordShortfall(values.password) === 0
  );
}

type Props = {
  values: AccountValues;
  onChange: (patch: Partial<AccountValues>) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
};

export function AccountScreen({
  values,
  onChange,
  onSubmit,
  isSubmitting,
}: Props) {
  const [emailTouched, setEmailTouched] = useState(false);
  const ready = accountReady(values);
  const shortfall = passwordShortfall(values.password);

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Welcome to the colony.</h1>
        <p className="onb-sub">
          A few quick questions and your workspace is ready.
        </p>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Enter submits the form from the panel wrapper; the inputs inside are the interactive controls. */}
      <div
        className="onb-panel"
        onKeyDown={(event) => {
          if (event.key === "Enter" && ready && !isSubmitting) onSubmit();
        }}
      >
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the custom Input renders a native input inside this label, so association holds in the rendered DOM. */}
        <label className="onb-field">
          <span className="onb-label">Your name</span>
          <Input
            value={values.name}
            placeholder="Aisha Bello"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the custom Input renders a native input inside this label, so association holds in the rendered DOM. */}
        <label className="onb-field">
          <span className="onb-label">Email</span>
          <Input
            type="email"
            value={values.email}
            placeholder="you@company.com"
            onBlur={() => setEmailTouched(true)}
            onChange={(e) => onChange({ email: e.target.value })}
          />
          {emailTouched && values.email && !isEmail(values.email) ? (
            <p className="onb-note onb-note-warn">
              That does not look like an email address.
            </p>
          ) : null}
        </label>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the custom Input renders a native input inside this label, so association holds in the rendered DOM. */}
        <label className="onb-field">
          <span className="onb-label">Password</span>
          <Input
            type="password"
            value={values.password}
            placeholder={`At least ${PASSWORD_MIN} characters`}
            onChange={(e) => onChange({ password: e.target.value })}
          />
          <Progress
            value={Math.min(100, (values.password.length / PASSWORD_MIN) * 100)}
          />
          <p className="onb-note">
            {shortfall === 0
              ? "Strong enough."
              : `${shortfall} more characters`}
          </p>
        </label>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: the custom Input renders a native input inside this label, so association holds in the rendered DOM. */}
        <label className="onb-field">
          <span className="onb-label">City</span>
          <Input
            value={values.city}
            onChange={(e) => onChange({ city: e.target.value })}
          />
          <p className="onb-note">Change it if we got it wrong.</p>
        </label>
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!ready || isSubmitting} onClick={onSubmit}>
          {isSubmitting ? "Creating your account" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
