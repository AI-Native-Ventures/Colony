import { BrowserSettings } from "@/features/browser/BrowserImport";
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Archive,
  BellRing,
  Building2,
  Blocks,
  Bot,
  ChevronDown,
  Cpu,
  Download,
  FlaskConical,
  Keyboard,
  LayoutDashboard,
  LayoutTemplate,
  MonitorCog,
  Moon,
  ShieldAlert,
  Smartphone,
  Smile,
  Sun,
  SunMoon,
  Ticket,
  UserRound,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import type {
  DesktopNotificationPermissionState,
  NotificationSettings,
} from "@/features/notifications/hooks";
import type { SoundName, SoundSlot } from "@/features/notifications/lib/sound";
import { BlocksSettingsCard } from "@/features/blocks/ui/BlocksSettingsCard";
import { CommunityMembersSettingsCard } from "@/features/community-members/ui/CommunityMembersSettingsCard";
import { CustomEmojiSettingsCard } from "@/features/custom-emoji/ui/CustomEmojiSettingsCard";
import { LocalArchiveSettingsCard } from "@/features/local-archive/ui/LocalArchiveSettingsCard";
import { cn } from "@/shared/lib/cn";
import { useCommunities } from "@/features/communities/useCommunities";
import { Badge } from "@/shared/ui/badge";
import { useTheme } from "@/shared/theme/ThemeProvider";
import type { SyntaxThemeName } from "@/shared/theme/theme-loader";
import { deriveWorkspaceAppearance } from "@/shared/theme/workspaceAppearance";
import {
  SystemPreferencePreviewFrame,
  ThemePreviewFrame,
} from "@/shared/theme/ThemePreviewFrame";
import {
  getThemeFallbackPreviewVars,
  useThemePreviewVars,
  withAccentPreviewVars,
} from "@/shared/theme/useThemePreviewVars";
import { appearanceCommunityLabel } from "../lib/appearanceScopeCopy";
import {
  CustomGradientControls,
  AccentPickerContent,
  GlassBackgroundSetting,
  LinkPreviewStyleSetting,
  ProminentActiveTabSetting,
  ThreadLayoutSetting,
} from "./AppearanceSettingsControls";
import { ChannelTemplatesSettingsCard } from "./ChannelTemplatesSettingsCard";
import { ExperimentalFeaturesCard } from "./ExperimentalFeaturesCard";
import { KeyboardShortcutsCard } from "./KeyboardShortcutsCard";
import { MeshComputeSettingsCard } from "@/features/mesh-compute/ui/MeshComputeSettingsCard";
import { MobilePairingCard } from "./MobilePairingCard";
import { ModerationQueueCard } from "./ModerationQueueCard";
import { NotificationSettingsCard } from "./NotificationSettingsCard";
import { OperatorConsoleCard } from "./OperatorConsoleCard";
import { AgentsSettingsPanel } from "./AgentsSettingsPanel";
import { SettingsOptionGroup, SettingsOptionRow } from "./SettingsOptionGroup";
import { ProfileSettingsCard } from "./ProfileSettingsCard";
import { UpdateChecker } from "../UpdateChecker";
import { CompanySettingsCard } from "./CompanySettingsCard";
import { WorkspacePatternSetting } from "./WorkspacePatternSetting";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import { VoiceSettingsCard } from "./VoiceSettingsCard";

export type SettingsSection =
  | "browser"
  | "profile"
  | "company"
  | "blocks"
  | "notifications"
  | "voice"
  | "experimental"
  | "agents"
  | "channel-templates"
  | "compute"
  | "appearance"
  | "shortcuts"
  | "community-members"
  | "moderation"
  | "operator-console"
  | "custom-emoji"
  | "local-archive"
  | "mobile"
  | "updates";

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "profile";

const SETTINGS_SECTION_VALUES: readonly SettingsSection[] = [
  "browser",
  "profile",
  "company",
  "blocks",
  "notifications",
  "voice",
  "experimental",
  "agents",
  "channel-templates",
  "compute",
  "appearance",
  "shortcuts",
  "community-members",
  "moderation",
  "operator-console",
  "custom-emoji",
  "local-archive",
  "mobile",
  "updates",
];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (
    typeof value === "string" &&
    (SETTINGS_SECTION_VALUES as readonly string[]).includes(value)
  );
}

export type SettingsSectionDescriptor = {
  value: SettingsSection;
  label: string;
  icon: LucideIcon;
  /** If set, this section is only visible when the feature is enabled */
  featureGate?: string;
};

export type SettingsPanelProps = {
  currentPubkey?: string;
  fallbackDisplayName?: string;
  isUpdatingDesktopNotifications: boolean;
  notificationErrorMessage: string | null;
  notificationPermission: DesktopNotificationPermissionState;
  notificationSettings: NotificationSettings;
  onSetDesktopNotificationsEnabled: (enabled: boolean) => Promise<boolean>;
  onSetHomeBadgeEnabled: (enabled: boolean) => void;
  onSetSlotAlertsEnabled: (slot: SoundSlot, enabled: boolean) => void;
  onSetNotifyWhileViewing: (enabled: boolean) => void;
  onSetAllSlotAlertsEnabled: (enabled: boolean) => void;
  onSetSoundForSlot: (slot: SoundSlot, name: SoundName) => void;
};

export const settingsSections: SettingsSectionDescriptor[] = [
  { value: "browser", label: "Browser", icon: MonitorCog },
  {
    value: "appearance",
    label: "Appearance",
    icon: MonitorCog,
  },
  {
    value: "profile",
    label: "Profile",
    icon: UserRound,
  },
  {
    value: "company",
    label: "Company",
    icon: Building2,
  },
  {
    value: "notifications",
    label: "Notifications",
    icon: BellRing,
  },
  {
    value: "voice",
    label: "Voice",
    icon: Volume2,
  },
  {
    value: "experimental",
    label: "Experiments",
    icon: FlaskConical,
  },
  {
    value: "agents",
    label: "Agents",
    icon: Bot,
    featureGate: "managed-agents",
  },
  {
    value: "channel-templates",
    label: "Channel templates",
    icon: LayoutTemplate,
    featureGate: "channel-templates",
  },
  {
    value: "compute",
    label: "Compute",
    icon: Cpu,
  },
  {
    value: "shortcuts",
    label: "Shortcuts",
    icon: Keyboard,
  },
  {
    value: "blocks",
    label: "Blocks",
    icon: Blocks,
  },
  {
    value: "community-members",
    label: "Invites",
    icon: Ticket,
  },
  {
    value: "moderation",
    label: "Moderation",
    icon: ShieldAlert,
  },
  {
    value: "operator-console",
    label: "Admin console",
    icon: LayoutDashboard,
  },
  {
    value: "custom-emoji",
    label: "Custom emoji",
    icon: Smile,
    featureGate: "custom-emoji",
  },
  {
    value: "local-archive",
    label: "Local archive",
    icon: Archive,
  },
  {
    value: "mobile",
    label: "Mobile",
    icon: Smartphone,
  },
  {
    value: "updates",
    label: "Updates",
    icon: Download,
  },
];

type AppearanceMode = "system" | "light" | "dark";

const APPEARANCE_MODE_OPTIONS = [
  { mode: "system" as const, label: "System", Icon: SunMoon },
  { mode: "light" as const, label: "Light", Icon: Sun },
  { mode: "dark" as const, label: "Dark", Icon: Moon },
] as const;

function ThemeSettingsCard() {
  const {
    setTheme,
    isDark,
    accentColor,
    setAccentColor,
    customGradient,
    setCustomGradient,
    followSystem,
    setFollowSystem,
  } = useTheme();

  // Per-community scoping labels only earn their place when the user is
  // actually in more than one community; with a single community there is
  // nothing to disambiguate.
  const { activeCommunity, communities } = useCommunities();
  const showCommunityScope = communities.length > 1;
  const communityLabel = appearanceCommunityLabel(activeCommunity?.name);

  const shouldReduceMotion = useReducedMotion();
  const previewVarsByTheme = useThemePreviewVars();
  const selectedMode: AppearanceMode = followSystem
    ? "system"
    : isDark
      ? "dark"
      : "light";
  const [themeStyleExpanded, setThemeStyleExpanded] = useState(false);
  const selectedThemeLabel = customGradient.enabled ? "Custom" : "Default";

  const getVars = (name: SyntaxThemeName) =>
    withAccentPreviewVars(
      previewVarsByTheme[name] ?? getThemeFallbackPreviewVars(name),
      accentColor,
    );
  const preview = (custom: boolean, className: string) => {
    const palettes = deriveWorkspaceAppearance(accentColor, {
      ...customGradient,
      enabled: custom,
    });
    const stops = {
      lightTop: palettes.light.chromeStart,
      lightBottom: palettes.light.chromeEnd,
      darkTop: palettes.dark.chromeStart,
      darkBottom: palettes.dark.chromeEnd,
    };
    return selectedMode === "system" ? (
      <SystemPreferencePreviewFrame
        className={className}
        lightVars={getVars("buzz")}
        darkVars={getVars("buzz-dark")}
        lightGradient={{ top: stops.lightTop, bottom: stops.lightBottom }}
        darkGradient={{ top: stops.darkTop, bottom: stops.darkBottom }}
      />
    ) : (
      <ThemePreviewFrame
        className={className}
        vars={getVars(selectedMode === "dark" ? "buzz-dark" : "buzz")}
        sidebarGradient={
          selectedMode === "dark"
            ? { top: stops.darkTop, bottom: stops.darkBottom }
            : { top: stops.lightTop, bottom: stops.lightBottom }
        }
      />
    );
  };
  const handleModeSelect = (mode: AppearanceMode) => {
    setFollowSystem(mode === "system");
    setTheme(mode === "dark" ? "buzz-dark" : "buzz");
  };
  const selectedThemePreview = preview(
    customGradient.enabled,
    "h-[112px] w-[168px] shrink-0",
  );
  const themeStyleGrid = (
    <div
      className="px-4 pb-4 pt-1"
      data-testid="theme-style-options"
      id="theme-style-options"
    >
      <div className="flex flex-wrap gap-4 p-1">
        {[
          { label: "Default", custom: false },
          { label: "Custom", custom: true },
        ].map(({ label, custom }) => (
          <button
            aria-pressed={customGradient.enabled === custom}
            className="group flex w-[168px] shrink-0 flex-col items-center text-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-md"
            data-testid={`theme-option-${label.toLowerCase()}`}
            key={label}
            onClick={() =>
              setCustomGradient({ ...customGradient, enabled: custom })
            }
            type="button"
          >
            {preview(
              custom,
              cn(
                "h-[112px] w-[168px] transition-shadow",
                customGradient.enabled === custom
                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : "group-hover:ring-2 group-hover:ring-border",
              ),
            )}
            <span
              className={cn(
                "mt-1.5 w-full truncate text-xs",
                customGradient.enabled === custom
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="settings-theme"
    >
      <SettingsSectionHeader
        title="Appearance"
        description="Choose how Colony looks and feels."
      />

      <div className="space-y-12">
        <SettingsOptionGroup
          data-testid="appearance-theme-card"
          headerAction={
            showCommunityScope && activeCommunity ? (
              <Badge
                className="max-w-56 font-medium normal-case tracking-normal"
                data-testid="appearance-community-badge"
                variant="outline"
              >
                <span className="truncate">{communityLabel}</span>
              </Badge>
            ) : null
          }
          title={
            <>
              Theme
              {showCommunityScope ? (
                <span className="ml-1 font-normal text-muted-foreground">
                  (per community)
                </span>
              ) : null}
            </>
          }
        >
          <SettingsOptionRow data-testid="appearance-color-mode-row">
            <div className="min-w-0">
              <p className="text-sm font-medium">Color mode</p>
              <p
                className="text-sm font-normal text-muted-foreground/70"
                data-settings-subcopy
              >
                Follow your system or choose a light or dark appearance.
              </p>
            </div>
            <fieldset
              className="relative isolate grid h-8 w-[15rem] shrink-0 grid-cols-3 overflow-hidden rounded-md bg-muted/45 p-0.5"
              data-testid="appearance-color-mode-control"
            >
              <legend className="sr-only">Color mode</legend>
              <div
                aria-hidden="true"
                className="absolute bottom-0.5 left-0.5 top-0.5 z-0 rounded-md bg-background shadow-sm transition-transform duration-[250ms] ease-out motion-reduce:transition-none"
                data-testid="appearance-color-mode-indicator"
                style={{
                  transform: `translateX(${APPEARANCE_MODE_OPTIONS.findIndex((option) => option.mode === selectedMode) * 100}%)`,
                  width: "calc((100% - 4px) / 3)",
                }}
              />
              {APPEARANCE_MODE_OPTIONS.map(({ mode, label, Icon }) => (
                <button
                  aria-pressed={selectedMode === mode}
                  className={cn(
                    "relative z-10 flex h-full items-center justify-center gap-1.5 rounded-md bg-transparent px-2.5 text-xs font-medium transition-colors duration-[250ms] ease-out focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    selectedMode === mode
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  data-testid={`appearance-mode-${mode}`}
                  key={mode}
                  onClick={() => handleModeSelect(mode)}
                  type="button"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </fieldset>
          </SettingsOptionRow>

          <SettingsOptionRow data-testid="theme-style-row">
            <div className="min-w-0">
              <p className="text-sm font-medium">Theme style</p>
              <p
                className="text-sm font-normal text-muted-foreground/70"
                data-settings-subcopy
              >
                Choose the colors used throughout Colony.
              </p>
            </div>
            <button
              aria-label={`Theme style, ${selectedThemeLabel}`}
              aria-controls="theme-style-options"
              aria-expanded={themeStyleExpanded}
              className="flex h-auto min-w-0 items-center gap-2 rounded-md bg-transparent p-0 text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="theme-style-trigger"
              onClick={() => setThemeStyleExpanded((expanded) => !expanded)}
              type="button"
            >
              <span
                className="shrink-0"
                data-testid="theme-style-selected-preview"
              >
                {selectedThemePreview}
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                  themeStyleExpanded && "rotate-180",
                )}
              />
            </button>
          </SettingsOptionRow>

          {shouldReduceMotion ? (
            themeStyleExpanded ? (
              themeStyleGrid
            ) : null
          ) : (
            <AnimatePresence initial={false}>
              {themeStyleExpanded ? (
                <motion.div
                  animate={{ height: "auto", opacity: 1, y: 0 }}
                  className="overflow-hidden"
                  exit={{ height: 0, opacity: 0, y: -6 }}
                  initial={{ height: 0, opacity: 0, y: -6 }}
                  key="theme-style-options"
                  transition={{
                    duration: 0.22,
                    ease: [0.23, 1, 0.32, 1],
                  }}
                >
                  {themeStyleGrid}
                </motion.div>
              ) : null}
            </AnimatePresence>
          )}

          {customGradient.enabled ? (
            <CustomGradientControls />
          ) : (
            <AccentPickerContent
              accentColor={accentColor}
              isDark={isDark}
              setAccentColor={setAccentColor}
            />
          )}
          <WorkspacePatternSetting />

          <GlassBackgroundSetting />
          <ProminentActiveTabSetting />
        </SettingsOptionGroup>

        <SettingsOptionGroup
          data-testid="appearance-preferences-card"
          title="Preferences"
        >
          <LinkPreviewStyleSetting />
          <ThreadLayoutSetting />
        </SettingsOptionGroup>
      </div>
    </section>
  );
}

export function renderSettingsSection(
  section: SettingsSection,
  props: SettingsPanelProps,
): React.ReactNode {
  switch (section) {
    case "browser":
      return <BrowserSettings />;
    case "profile":
      return (
        <ProfileSettingsCard
          currentPubkey={props.currentPubkey}
          fallbackDisplayName={props.fallbackDisplayName}
        />
      );
    case "company":
      return <CompanySettingsCard />;
    case "notifications":
      return (
        <NotificationSettingsCard
          isUpdatingDesktopNotifications={props.isUpdatingDesktopNotifications}
          notificationErrorMessage={props.notificationErrorMessage}
          notificationPermission={props.notificationPermission}
          notificationSettings={props.notificationSettings}
          onSetDesktopNotificationsEnabled={
            props.onSetDesktopNotificationsEnabled
          }
          onSetHomeBadgeEnabled={props.onSetHomeBadgeEnabled}
          onSetSlotAlertsEnabled={props.onSetSlotAlertsEnabled}
          onSetNotifyWhileViewing={props.onSetNotifyWhileViewing}
          onSetAllSlotAlertsEnabled={props.onSetAllSlotAlertsEnabled}
          onSetSoundForSlot={props.onSetSoundForSlot}
        />
      );
    case "voice":
      return <VoiceSettingsCard />;
    case "experimental":
      return <ExperimentalFeaturesCard />;
    case "agents":
      return <AgentsSettingsPanel />;
    case "channel-templates":
      return <ChannelTemplatesSettingsCard />;
    case "compute":
      return <MeshComputeSettingsCard />;
    case "appearance":
      return <ThemeSettingsCard />;
    case "shortcuts":
      return <KeyboardShortcutsCard />;
    case "blocks":
      return <BlocksSettingsCard />;
    case "community-members":
      return (
        <CommunityMembersSettingsCard currentPubkey={props.currentPubkey} />
      );
    case "moderation":
      return <ModerationQueueCard />;
    case "operator-console":
      return <OperatorConsoleCard />;
    case "custom-emoji":
      return <CustomEmojiSettingsCard />;
    case "local-archive":
      return <LocalArchiveSettingsCard />;
    case "mobile":
      return <MobilePairingCard currentPubkey={props.currentPubkey} />;
    case "updates":
      return <UpdateChecker />;
    default: {
      const exhaustiveCheck: never = section;
      return exhaustiveCheck;
    }
  }
}
