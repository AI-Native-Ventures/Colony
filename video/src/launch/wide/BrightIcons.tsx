import { POPPINS } from "../fonts";
import { BRIGHT_COLORS as C, type ServiceIcon } from "./bright.ts";

/** Bright Plumbing's mark: a white water drop on a blue tile. */
export const BrightMark: React.FC<{ size: number; tile?: string }> = ({
  size,
  tile = C.blue,
}) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 32 32">
    <rect width="32" height="32" rx="9" fill={tile} />
    <path
      d="M16 5.5C16 5.5 8.8 14.2 8.8 19.1a7.2 7.2 0 0 0 14.4 0C23.2 14.2 16 5.5 16 5.5Z"
      fill="#ffffff"
    />
    <path
      d="M12.6 19.6a3.4 3.4 0 0 0 3.4 3.3"
      fill="none"
      stroke={tile}
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);

/** Mark plus name, on one line, for the corner of a post. */
export const BrightLockup: React.FC<{
  size: number;
  color?: string;
  tile?: string;
}> = ({ size, color = C.navy, tile }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: size * 0.38,
      fontFamily: POPPINS,
      fontWeight: 700,
      fontSize: size * 0.52,
      letterSpacing: "0.14em",
      color,
      whiteSpace: "nowrap",
    }}
  >
    <BrightMark size={size} tile={tile} />
    BRIGHT PLUMBING
  </div>
);

type IconProps = { size: number; color: string; stroke?: number };

function Svg({
  size,
  children,
}: {
  size: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ display: "block", flex: "none" }}
    >
      {children}
    </svg>
  );
}

export const PhoneIcon: React.FC<IconProps> = ({ size, color }) => (
  <Svg size={size}>
    <path
      d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z"
      fill={color}
    />
  </Svg>
);

export const StarIcon: React.FC<IconProps> = ({ size, color }) => (
  <Svg size={size}>
    <path
      d="M12 2.6l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5-4.9-4.6 6.6-.8z"
      fill={color}
    />
  </Svg>
);

export const ArrowIcon: React.FC<IconProps> = ({
  size,
  color,
  stroke = 2.4,
}) => (
  <Svg size={size}>
    <path
      d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ArrowUpRightIcon: React.FC<IconProps> = ({
  size,
  color,
  stroke = 2.4,
}) => (
  <Svg size={size}>
    <path
      d="M7 17L17 7M9 7h8v8"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ClockIcon: React.FC<IconProps> = ({
  size,
  color,
  stroke = 1.9,
}) => (
  <Svg size={size}>
    <circle
      cx="12"
      cy="12"
      r="8.5"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
    />
    <path
      d="M12 7.5V12l3 2"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ShieldIcon: React.FC<IconProps> = ({
  size,
  color,
  stroke = 1.9,
}) => (
  <Svg size={size}>
    <path
      d="M12 3.2l7 2.8v5.2c0 4.4-3 8.1-7 9.4-4-1.3-7-5-7-9.4V6l7-2.8Z"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinejoin="round"
    />
    <path
      d="M8.8 12.1l2.2 2.2 4.3-4.4"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const PinIcon: React.FC<IconProps> = ({ size, color, stroke = 1.9 }) => (
  <Svg size={size}>
    <path
      d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11Z"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinejoin="round"
    />
    <circle
      cx="12"
      cy="10"
      r="2.3"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
    />
  </Svg>
);

export const TagIcon: React.FC<IconProps> = ({ size, color, stroke = 1.9 }) => (
  <Svg size={size}>
    <path
      d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.4 1.4 0 0 1 0 2l-6.1 6.1a1.4 1.4 0 0 1-2 0l-9-9Z"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinejoin="round"
    />
    <circle cx="8.2" cy="8.2" r="1.5" fill={color} />
  </Svg>
);

/** The line icons on the site's service cards. */
export const ServiceGlyph: React.FC<{
  icon: ServiceIcon;
  size: number;
  color: string;
}> = ({ icon, size, color }) => {
  const sw = 1.9;
  if (icon === "drop") {
    return (
      <Svg size={size}>
        <path
          d="M12 3.2S6 10 6 14.4a6 6 0 0 0 12 0C18 10 12 3.2 12 3.2Z"
          fill="none"
          stroke={color}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
        <path
          d="M9.4 14.8a2.7 2.7 0 0 0 2.6 2.6"
          fill="none"
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </Svg>
    );
  }
  if (icon === "drain") {
    return (
      <Svg size={size}>
        <circle
          cx="12"
          cy="12"
          r="8.4"
          fill="none"
          stroke={color}
          strokeWidth={sw}
        />
        <path
          d="M12 5.5v13M5.5 12h13M7.4 7.4l9.2 9.2M16.6 7.4l-9.2 9.2"
          fill="none"
          stroke={color}
          strokeWidth={sw * 0.8}
          strokeLinecap="round"
        />
        <circle
          cx="12"
          cy="12"
          r="2.4"
          fill="#ffffff"
          stroke={color}
          strokeWidth={sw}
        />
      </Svg>
    );
  }
  return (
    <Svg size={size}>
      <rect
        x="6.5"
        y="3.5"
        width="11"
        height="17"
        rx="4.2"
        fill="none"
        stroke={color}
        strokeWidth={sw}
      />
      <circle
        cx="12"
        cy="9"
        r="2.2"
        fill="none"
        stroke={color}
        strokeWidth={sw}
      />
      <path
        d="M9.5 15h5M12 20.5v1.5"
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
      />
    </Svg>
  );
};
