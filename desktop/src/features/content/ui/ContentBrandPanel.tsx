import * as React from "react";

import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";

import type { ContentStyle } from "../contracts";
import type { BrandKit, BrandMark } from "../render/kit";
import {
  useAddStyleReference,
  useContentBrandKit,
  useRemoveStyleReference,
  useRevokeStyleRule,
  useSetBrandLogo,
  useSetStyleVoice,
} from "../hooks";

/**
 * The Brand page: the company's identity, in plain words.
 *
 * The reader is not a designer and never will be, so nothing here speaks
 * design: no ratios, no versions, no type terms. Four things they can
 * recognise and act on: their logo, their colors, their words, and the
 * things they like. The measurements that back all of it stay in the data
 * where the agent reads them.
 */

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored logo mark, if the kit carries one. */
function kitLogoMark(kit: BrandKit | null | undefined): BrandMark | null {
  if (!kit) {
    return null;
  }
  for (const role of ["logo", "icon", "wordmark"] as const) {
    const mark = kit.marks.find((entry) => entry.role === role);
    if (mark) {
      return mark;
    }
  }
  return null;
}

/** The website the kit was scanned from, if it was. */
function kitWebsite(kit: BrandKit | null | undefined): string | null {
  if (!kit || kit.source.type !== "scan") {
    return null;
  }
  try {
    return new URL(kit.source.url).host || kit.source.url;
  } catch {
    return kit.source.url;
  }
}

/**
 * The backgrounds the logo is shown on: the darkest and lightest ends of the
 * lead hue's ramp plus its base. Chosen, not labelled: the owner sees their
 * logo where it will actually sit, and never a color code.
 */
function logoGrounds(kit: BrandKit | null | undefined): string[] {
  const hue = kit?.hues[0];
  if (!hue) {
    return ["#1b1033", "#5b2ee5", "#f6f3ff"];
  }
  const ramp = hue.ramp.length > 0 ? hue.ramp : [hue.base];
  const first = ramp[0];
  const last = ramp[ramp.length - 1];
  return [...new Set([first, hue.base, last])];
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-semibold tracking-tight">{children}</h3>;
}

function LogoSection({
  communityId,
  kit,
}: {
  communityId: string;
  kit: BrandKit | null | undefined;
}) {
  const setLogo = useSetBrandLogo(communityId);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const mark = kitLogoMark(kit);
  const logoUrl = mark ? rewriteRelayUrl(mark.media_url) : null;
  const onDark = mark?.variants.find((v) => v.purpose === "on-dark") ?? null;
  const onLight = mark?.variants.find((v) => v.purpose === "on-light") ?? null;

  const handleFile = React.useCallback(
    async (file: File) => {
      setError(null);
      try {
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        await setLogo.mutateAsync({
          bytes,
          filename: file.name,
          isSvg:
            file.type === "image/svg+xml" ||
            file.name.toLowerCase().endsWith(".svg"),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [setLogo],
  );

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>Your logo</SectionTitle>
        <Button
          disabled={setLogo.isPending}
          onClick={() => inputRef.current?.click()}
          size="sm"
          variant="outline"
        >
          {setLogo.isPending
            ? "Saving…"
            : logoUrl
              ? "Replace it"
              : "Add your logo"}
        </Button>
      </div>
      <input
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        data-testid="brand-logo-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void handleFile(file);
          }
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      {logoUrl && (onDark || onLight) ? (
        // The derived versions, each on the ground it exists for, the way a
        // brand book opens: the agent made these, the owner only recognises.
        <>
          <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
            Your agent made these from the one you gave it, so every card gets
            the version that reads on its background.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div className="min-w-0">
              <div className="flex aspect-square items-center justify-center rounded-xl bg-background ring-1 ring-border/40">
                <img
                  alt="Your logo"
                  className="max-h-16 max-w-16"
                  src={logoUrl}
                />
              </div>
              <p className="mt-1.5 text-center text-2xs text-muted-foreground">
                As it is
              </p>
            </div>
            {onDark ? (
              <div className="min-w-0">
                <div
                  className="flex aspect-square items-center justify-center rounded-xl"
                  style={{ backgroundColor: logoGrounds(kit)[0] }}
                >
                  <img
                    alt="Your logo, for dark cards"
                    className="max-h-16 max-w-16"
                    src={rewriteRelayUrl(onDark.media_url)}
                  />
                </div>
                <p className="mt-1.5 text-center text-2xs text-muted-foreground">
                  On dark cards
                </p>
              </div>
            ) : null}
            {onLight ? (
              <div className="min-w-0">
                <div
                  className="flex aspect-square items-center justify-center rounded-xl ring-1 ring-border/40"
                  style={{
                    backgroundColor:
                      logoGrounds(kit)[logoGrounds(kit).length - 1],
                  }}
                >
                  <img
                    alt="Your logo, for light cards"
                    className="max-h-16 max-w-16"
                    src={rewriteRelayUrl(onLight.media_url)}
                  />
                </div>
                <p className="mt-1.5 text-center text-2xs text-muted-foreground">
                  On light cards
                </p>
              </div>
            ) : null}
          </div>
        </>
      ) : logoUrl ? (
        // A logo without derived versions yet: shown where it will actually
        // live, one plate per ground.
        <div className="mt-3 flex gap-3">
          {logoGrounds(kit).map((ground) => (
            <div
              className="flex aspect-square flex-1 items-center justify-center rounded-xl ring-1 ring-border/30"
              key={ground}
              style={{ backgroundColor: ground }}
            >
              <img
                alt="Your logo"
                className="max-h-16 max-w-16"
                src={logoUrl}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 flex aspect-[3/1] items-center justify-center rounded-xl bg-muted/40 px-6 text-center">
          <p className="max-w-prose text-sm text-muted-foreground">
            No logo yet. Add one, and your agent makes the versions your cards
            need.
          </p>
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function ColorsSection({ kit }: { kit: BrandKit | null | undefined }) {
  if (!kit || kit.hues.length === 0) {
    return null;
  }
  return (
    <section>
      <SectionTitle>Your colors</SectionTitle>
      {/* One joined strip rather than loose chips: colors read as a palette
          when they touch, and as a settings page when they don't. */}
      <div className="mt-3 flex h-20 overflow-hidden rounded-xl ring-1 ring-border/30">
        {kit.hues.map((hue) => (
          <div
            className="flex-1"
            key={hue.name}
            style={{ backgroundColor: hue.base }}
            title={hue.name}
          />
        ))}
      </div>
      <div className="mt-1.5 flex">
        {kit.hues.map((hue) => (
          <span
            className="flex-1 text-center text-2xs text-muted-foreground"
            key={hue.name}
          >
            {hue.name}
          </span>
        ))}
      </div>
      <p className="mt-3 max-w-prose text-xs text-muted-foreground">
        Taken from your website. Every card is drawn from these, and nothing
        goes out unreadable on them.
      </p>
    </section>
  );
}

function VoiceSection({
  communityId,
  style,
}: {
  communityId: string;
  style: ContentStyle | null;
}) {
  const setVoice = useSetStyleVoice(communityId);
  const voice = isRecord(style?.settings.voice) ? style.settings.voice : {};
  const storedBanned = Array.isArray(style?.settings.banned_words)
    ? style.settings.banned_words.filter(
        (word): word is string => typeof word === "string",
      )
    : [];
  const [tagline, setTagline] = React.useState(
    typeof voice.tagline === "string" ? voice.tagline : "",
  );
  const [sound, setSound] = React.useState(
    typeof voice.sound === "string" ? voice.sound : "",
  );
  const [banned, setBanned] = React.useState(storedBanned.join(", "));
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSave = React.useCallback(async () => {
    setError(null);
    setSaved(false);
    try {
      await setVoice.mutateAsync({
        banned_words: banned.split(",").map((word) => word.trim()),
        sound,
        tagline,
      });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [banned, setVoice, sound, tagline]);

  return (
    <section>
      <SectionTitle>Your words</SectionTitle>
      <div className="mt-2 grid max-w-xl gap-3">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Tagline
          <input
            className="rounded-md border border-input/40 bg-background p-2 text-sm font-normal text-foreground"
            data-testid="brand-tagline-input"
            onChange={(event) => setTagline(event.target.value)}
            placeholder="One line that says what you do"
            value={tagline}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          How posts should sound
          <input
            className="rounded-md border border-input/40 bg-background p-2 text-sm font-normal text-foreground"
            onChange={(event) => setSound(event.target.value)}
            placeholder="Confident and plain. No hype."
            value={sound}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Words to never use
          <input
            className="rounded-md border border-input/40 bg-background p-2 text-sm font-normal text-foreground"
            onChange={(event) => setBanned(event.target.value)}
            placeholder="Separated by commas"
            value={banned}
          />
        </label>
        <div className="flex items-center gap-2">
          <Button disabled={setVoice.isPending} onClick={handleSave} size="sm">
            {setVoice.isPending ? "Saving…" : "Save"}
          </Button>
          {saved ? (
            <span className="text-xs text-muted-foreground">
              Saved. Your agent follows this from the next card on.
            </span>
          ) : null}
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </section>
  );
}

function ReferencesSection({
  communityId,
  style,
}: {
  communityId: string;
  style: ContentStyle | null;
}) {
  const addReference = useAddStyleReference(communityId);
  const removeReference = useRemoveStyleReference(communityId);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const references = Array.isArray(style?.settings.references)
    ? style.settings.references
        .filter(isRecord)
        .filter(
          (entry): entry is { url: string; sha256: string } =>
            typeof entry.url === "string" && typeof entry.sha256 === "string",
        )
    : [];

  const handleFiles = React.useCallback(
    async (files: FileList) => {
      setError(null);
      try {
        for (const file of Array.from(files)) {
          // Sequential: each one reads the freshest style head before
          // appending, and two racing would drop one another's entry.
          await addReference.mutateAsync({
            bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
            filename: file.name,
          });
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [addReference],
  );

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>Things you like</SectionTitle>
        <Button
          disabled={addReference.isPending}
          onClick={() => inputRef.current?.click()}
          size="sm"
          variant="outline"
        >
          {addReference.isPending ? "Saving…" : "Add pictures"}
        </Button>
      </div>
      <input
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        data-testid="brand-reference-input"
        multiple
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0) {
            void handleFiles(event.target.files);
          }
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Seen a post or a design you wish was yours? Put it here. Screenshots
        from anywhere. Your agent studies them and leans that way.
      </p>
      {references.length > 0 ? (
        // A pinboard, not a row of thumbnails: three across, square, touching
        // shoulders, the way the owner saw them in a feed.
        <div className="mt-4 grid grid-cols-3 gap-3">
          {references.map((reference) => (
            <figure className="group relative min-w-0" key={reference.sha256}>
              <img
                alt="Something you like"
                className="aspect-square w-full rounded-xl object-cover ring-1 ring-border/30"
                src={rewriteRelayUrl(reference.url)}
              />
              <button
                className="absolute right-1.5 top-1.5 hidden rounded-md bg-background/90 px-1.5 py-0.5 text-xs shadow-sm group-hover:block"
                onClick={() => removeReference.mutate(reference.sha256)}
                type="button"
              >
                Remove
              </button>
            </figure>
          ))}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function RulesSection({
  communityId,
  style,
}: {
  communityId: string;
  style: ContentStyle | null;
}) {
  const revoke = useRevokeStyleRule(communityId);
  const rules = style?.rules ?? [];
  const active = rules.filter((rule) => rule.active);
  const revoked = rules.filter((rule) => !rule.active);

  return (
    <section>
      <SectionTitle>Your rules</SectionTitle>
      {active.length === 0 && revoked.length === 0 ? (
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Nothing yet. When you send a card back and choose “every card, from
          now on”, your words land here and every future card follows them.
        </p>
      ) : (
        <>
          <ul className="mt-3 space-y-3">
            {active.map((rule) => (
              <li className="rounded-xl bg-muted/30 p-4" key={rule.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">{rule.text}</p>
                  <Button
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(rule.id)}
                    size="sm"
                    variant="ghost"
                  >
                    Stop applying
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  From {formatDate(rule.origin.at)}: “{rule.origin.quote}”
                </p>
              </li>
            ))}
          </ul>
          {revoked.length > 0 ? (
            <>
              <h4 className="mt-5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                No longer applied
              </h4>
              <ul className="mt-2 space-y-2">
                {revoked.map((rule) => (
                  <li
                    className="rounded-xl bg-muted/20 p-4 opacity-70"
                    key={rule.id}
                  >
                    <p className="text-sm line-through">{rule.text}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      From {formatDate(rule.origin.at)}: “{rule.origin.quote}”
                    </p>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

export function ContentBrandPanel({
  communityId,
  sampleImageUrl,
  style,
}: {
  communityId: string;
  /** The newest rendered card, so the page can show what posts look like. */
  sampleImageUrl: string | null;
  style: ContentStyle | null;
}) {
  const kitQuery = useContentBrandKit(communityId);
  const website = kitWebsite(kitQuery.data);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* A brand book, not a settings form: one centered, unhurried column. */}
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <h2 className="text-2xl font-semibold tracking-tight">Brand</h2>
        <p className="mt-1 max-w-prose text-base text-muted-foreground">
          What your company looks and sounds like. Your agent follows all of it,
          and nothing goes out without your approval.
        </p>

        {website ? (
          <div className="mt-6 flex items-center gap-2.5 rounded-lg bg-muted/30 px-3 py-2.5">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
            />
            <span className="text-sm font-medium">{website}</span>
            <span className="ml-auto text-2xs text-muted-foreground">
              Logo, colors and words pulled from here
            </span>
          </div>
        ) : null}

        <div className="mt-10 grid gap-12">
          <LogoSection communityId={communityId} kit={kitQuery.data} />
          <ColorsSection kit={kitQuery.data} />
          <VoiceSection communityId={communityId} style={style} />
          <ReferencesSection communityId={communityId} style={style} />
          <RulesSection communityId={communityId} style={style} />
          {sampleImageUrl ? (
            <section>
              <SectionTitle>Posts look like this</SectionTitle>
              <img
                alt="Your latest card"
                className="mt-3 w-64 rounded-xl shadow-md"
                src={rewriteRelayUrl(sampleImageUrl)}
              />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
