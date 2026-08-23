import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "buzz";

const RELAYS = [
  {
    id: "relay-eu",
    name: "relay.colony.ventures",
    region: "eu-west",
    events: "1.2M events",
  },
  {
    id: "relay-us",
    name: "us.colony.ventures",
    region: "us-east",
    events: "840k events",
  },
  {
    id: "relay-ap",
    name: "ap.colony.ventures",
    region: "ap-south",
    events: "312k events",
  },
  {
    id: "relay-lab",
    name: "lab.colony.ventures",
    region: "staging",
    events: "18k events",
  },
  {
    id: "relay-archive",
    name: "archive.colony.ventures",
    region: "cold storage",
    events: "4.8M events",
  },
];

const ONBOARDING = [
  {
    id: "step-1",
    step: "Step 1 of 3",
    title: "Claim your invite",
    body: "An owner approves every claim before the relay lets you publish.",
  },
  {
    id: "step-2",
    step: "Step 2 of 3",
    title: "Join a channel",
    body: "Channels are scoped by an h tag, so your reads stay inside the community.",
  },
  {
    id: "step-3",
    step: "Step 3 of 3",
    title: "Launch an agent",
    body: "Worker-tier agents raise typed asks instead of messaging owners directly.",
  },
];

export function Default() {
  return (
    // CarouselPrevious/Next are absolutely positioned at -left-12 / -right-12
    // of the carousel root, so the gutter has to live on a wrapper. Padding on
    // the carousel itself is inside the root and leaves them clipped.
    <div className="w-full px-14">
      <Carousel
        aria-label="Connected relays"
        className="w-full"
        opts={{ align: "start", loop: false }}
      >
        <CarouselContent>
          {RELAYS.map((relay) => (
            <CarouselItem className="basis-1/3" key={relay.id}>
              <div className="flex h-32 flex-col justify-between rounded-xl border border-border bg-background p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {relay.name}
                  </p>
                  <p className="text-2xs uppercase tracking-wide text-muted-foreground">
                    {relay.region}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">{relay.events}</p>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </div>
  );
}

export function SingleSlide() {
  return (
    <div className="w-full px-14">
      <Carousel aria-label="Getting started" className="w-full">
        <CarouselContent>
          {ONBOARDING.map((slide) => (
            <CarouselItem key={slide.id}>
              <div className="rounded-xl border border-border bg-muted/40 px-6 py-8 text-center">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {slide.step}
                </p>
                <p className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                  {slide.title}
                </p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  {slide.body}
                </p>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </div>
  );
}
