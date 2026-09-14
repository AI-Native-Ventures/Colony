import * as React from "react";

import { parseAnimatedAvatarUrl } from "@/shared/lib/animatedAvatar";
import { cn } from "@/shared/lib/cn";
import { identityColourClass } from "@/shared/lib/identityColour";
import { getInitials } from "@/shared/lib/initials";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { Avatar, AvatarFallback, AvatarImage } from "@/shared/ui/avatar";

type UserAvatarSize = "xs" | "sm" | "md";

const sizeClasses: Record<UserAvatarSize, string> = {
  xs: "h-5 w-5 text-3xs",
  sm: "h-6 w-6 text-2xs",
  md: "h-9 w-9 text-xs",
};

type UserAvatarProps = {
  avatarUrl: string | null;
  displayName: string;
  /**
   * Label used to derive fallback initials; defaults to `displayName`.
   *
   * Callers whose `displayName` is a generated role-prefixed key fallback
   * ("Agent npub1abcd…wxyz") pass the unprefixed compact key here:
   * word-initials would collapse every unnamed identity onto "AN"/"PN",
   * while the compact key keeps distinct key-tail initials. Authored
   * display names keep their name initials. The fallback color keeps
   * hashing `displayName`, which still contains the key.
   */
  initialsLabel?: string;
  /**
   * Agent identities render as squircles, humans as circles, so the shape
   * itself says which is which without reading a label (#7106, #7307).
   */
  shape?: "circle" | "squircle";
  size?: UserAvatarSize;
  accent?: boolean;
  identitySeed?: string;
  className?: string;
  fallbackDelayMs?: number;
  testId?: string;
};

export function UserAvatar({
  avatarUrl,
  displayName,
  initialsLabel,
  shape = "circle",
  size = "md",
  accent = false,
  identitySeed,
  className,
  fallbackDelayMs = 200,
  testId,
}: UserAvatarProps) {
  const initials = getInitials(initialsLabel ?? displayName);
  // Animated avatars show their static poster frame until hovered, then play
  // the animation.
  const animated = parseAnimatedAvatarUrl(avatarUrl);
  const [isHovered, setIsHovered] = React.useState(false);
  const src = animated
    ? rewriteRelayUrl(isHovered ? animated.animationUrl : animated.posterUrl)
    : avatarUrl
      ? rewriteRelayUrl(avatarUrl)
      : null;

  return (
    <Avatar
      // Animated avatars carry their own backdrop disc and transparent
      // surroundings — any container fill would flatten the pop-out.
      className={cn(
        sizeClasses[size],
        shape === "squircle" ? "rounded-squircle" : "rounded-full",
        !animated && "shadow-xs",
        className,
      )}
      data-avatar-shape={shape}
      data-testid={testId}
      onMouseEnter={animated ? () => setIsHovered(true) : undefined}
      onMouseLeave={animated ? () => setIsHovered(false) : undefined}
    >
      {src ? (
        <AvatarImage
          alt={`${displayName} avatar`}
          className={cn("object-cover", !animated && "bg-secondary")}
          data-testid={testId ? `${testId}-image` : undefined}
          referrerPolicy="no-referrer"
          src={src}
        />
      ) : null}
      <AvatarFallback
        className={cn(
          "font-semibold",
          identitySeed
            ? identityColourClass(identitySeed)
            : accent
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-secondary-foreground",
        )}
        data-testid={testId ? `${testId}-fallback` : undefined}
        delayMs={fallbackDelayMs}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
