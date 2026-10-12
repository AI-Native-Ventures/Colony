import assert from "node:assert/strict";
import { test } from "node:test";
import { PHONE_CARD, PHONE_PAD } from "../../explainers/phone.ts";
import { NOTE_TOP } from "../../explainers/ep01Phone.ts";
import { LEAD_ROWS, NAME_LEFT } from "../../explainers/ep03Phone.ts";
import {
  CALL_PHONE,
  CALL_STACK_GAP,
  PHONE_BODY,
  phoneBodyLineTop,
  phoneBodyTop,
} from "../../explainers/ep04Phone.ts";
import { LEADS } from "../wide/beat.ts";
import { PAGE_H } from "../../explainers/ep06Phone.ts";
import { GREEN90, PANS, PINK90, YES90 } from "../wide/film90.ts";
import { POSTS, postLandsAt } from "../wide/posts.ts";
import { YES_ROWS } from "../wide/yes.ts";
import { CALL } from "../wide/call.ts";
import { EMAIL } from "../wide/email.ts";
import { SCOUT_TASKS } from "../wide/scout.ts";
import {
  BRIGHT_OLD_PHONE,
  BRIGHT_PHONE,
  FILM_LEADS,
  FILM_PLAN,
  FILM_POST_ROWS,
  FILM_SALES,
  INBOX_BUTTONS,
  INBOX_ROWS,
  inboxCarryPath,
  inboxCursorKeys,
  inboxOwnerSpot,
  inboxRowTop,
  filmPlanAvatar,
  filmPostCarryPath,
  filmPostTop,
} from "./filmPages.ts";

test("the film's four jobs fit the plan card under Scout, above Scout's note", () => {
  const { rows } = FILM_PLAN;
  assert.equal(FILM_PLAN.tasks.length, SCOUT_TASKS.length);
  assert.ok(rows.top >= 116 + 64 + 20, "the jobs run into Scout's row");
  assert.ok(
    rows.top + (SCOUT_TASKS.length - 1) * rows.step + rows.h <= NOTE_TOP - 8,
  );
  for (const task of SCOUT_TASKS) {
    assert.ok(
      task.text.length * 0.56 * 32 <= PHONE_CARD.w - PHONE_PAD - 140,
      task.text,
    );
  }
});

test("each job's avatar is inside its row, in frame pixels", () => {
  SCOUT_TASKS.forEach((_, i) => {
    const a = filmPlanAvatar(i);
    const top = PHONE_CARD.y + FILM_PLAN.rows.top + i * FILM_PLAN.rows.step;
    assert.ok(a.y > top && a.y < top + FILM_PLAN.rows.h);
    assert.ok(
      a.x > PHONE_CARD.x + PHONE_PAD && a.x < PHONE_CARD.x + PHONE_PAD + 120,
    );
  });
});

test("the film's seven leads fit the leads card under the title's line", () => {
  assert.equal(FILM_LEADS.leads, LEADS);
  const subline = FILM_LEADS.subline ?? "";
  assert.ok(subline.length > 0, "the card says what the leads are");
  assert.ok(subline.length * 0.5 * 26 <= PHONE_CARD.w - 2 * PHONE_PAD);
  assert.ok(FILM_LEADS.rowsTop >= 108 + 34 + 24, "the rows run into the line");
  const bottom =
    FILM_LEADS.rowsTop + (LEADS.length - 1) * LEAD_ROWS.step + LEAD_ROWS.h;
  assert.ok(bottom <= PHONE_CARD.h - 60, `rows end at ${bottom}`);
  for (const lead of LEADS) {
    const nameEnd = NAME_LEFT + lead.name.length * 0.56 * 30;
    assert.ok(nameEnd <= PHONE_CARD.w - PHONE_PAD - 64 - 24, lead.name);
  }
});

const TEXT_W = PHONE_CARD.w - 2 * PHONE_PAD;

/** Lines a bubble of `text` wraps to at the call's 28 px, a generous Inter estimate. */
function bubbleLines(text: string): number {
  return Math.ceil((text.length * 0.55 * 28) / (CALL_PHONE.bubbleW - 48));
}

test("Thabo's email fits the phone: the subject on two lines, the body under it", () => {
  assert.equal(FILM_SALES.email, EMAIL);
  const subject = FILM_SALES.subjectLines ?? [EMAIL.subject];
  assert.equal(subject.join(" "), EMAIL.subject);
  assert.ok(EMAIL.subject.length * 0.6 * 36 > TEXT_W, "one line would do");
  for (const line of subject) assert.ok(line.length * 0.6 * 36 <= TEXT_W, line);
  for (const line of EMAIL.lines)
    assert.ok(line.length * 0.55 * PHONE_BODY.size <= TEXT_W, line);
  const top = phoneBodyTop(subject.length);
  const last = phoneBodyLineTop(EMAIL.lines.length - 1, top);
  assert.ok(last + PHONE_BODY.lineHeight <= PHONE_CARD.h - 60);
});

test("Lindiwe's call stacks its bubbles by their height and fits the phone", () => {
  assert.equal(FILM_SALES.call, CALL);
  assert.equal(FILM_SALES.stackCall, true);
  const [us, them] = CALL.lines.map((l) => bubbleLines(l.text) * 28 * 1.3 + 32);
  assert.ok(
    CALL_PHONE.usTop + us > CALL_PHONE.themTop,
    "the fixed slots would overlap",
  );
  const bottom =
    CALL_PHONE.usTop +
    us +
    CALL_STACK_GAP +
    them +
    CALL_STACK_GAP +
    CALL_PHONE.bookedH;
  assert.ok(bottom <= PHONE_CARD.h - 40, `the call ends at ${bottom}`);
});

test("the film's three posts fill the posts card, a row each, all in view", () => {
  const { post, textLeft } = FILM_POST_ROWS;
  assert.equal(POSTS.length, 3);
  assert.ok(filmPostTop(0) >= 116, "the posts run into the title");
  assert.ok(filmPostTop(2) + post <= PHONE_CARD.h - 16);
  assert.ok(filmPostTop(1) - (filmPostTop(0) + post) >= 12, "rows touch");
  assert.ok(textLeft >= PHONE_PAD + post + 24, "the time runs into the post");
  for (const p of POSTS) {
    const timeEnd = textLeft + 52 + p.when.length * 0.6 * 44;
    assert.ok(timeEnd <= PHONE_CARD.w - PHONE_PAD, p.when);
  }
});

test("each carrier comes in from the card's right edge to the right of its row's time", () => {
  POSTS.forEach((p, i) => {
    const path = filmPostCarryPath(i);
    const end = path[path.length - 1];
    assert.ok(path[0].x > PHONE_CARD.w + 30, "starts in view");
    const timeEnd = FILM_POST_ROWS.textLeft + 52 + p.when.length * 0.6 * 44;
    assert.ok(end.x - 34 >= timeEnd + 20, "stops on the time");
    assert.ok(
      end.y > filmPostTop(i) && end.y < filmPostTop(i) + FILM_POST_ROWS.post,
    );
  });
});

test("every post is down before the posts are ready, and well before the page scrolls on", () => {
  const leave = PANS.find((p) => p.to === "green");
  assert.ok(leave);
  POSTS.forEach((_, i) => {
    assert.ok(postLandsAt(i, PINK90) <= PINK90.readyAt);
    assert.ok(postLandsAt(i, PINK90) + 0.45 + 1 <= leave.start);
  });
});

test("Bright's pages fit the phone browser, top to bottom, in order", () => {
  for (const page of [BRIGHT_PHONE, BRIGHT_OLD_PHONE]) {
    const bands = Object.values(page);
    bands.forEach((band, k) => {
      assert.ok(band.bottom > band.top);
      if (k > 0) assert.ok(band.top >= bands[k - 1].bottom, "bands overlap");
    });
    assert.ok(bands[bands.length - 1].bottom <= PAGE_H, "runs off the page");
  }
  assert.equal(
    BRIGHT_OLD_PHONE.footer.bottom,
    PAGE_H,
    "the old footer sits at the foot",
  );
});

test("the repaint is done before the address bar says Updated, and before the page moves on", () => {
  const leave = PANS.find((p) => p.to === "yes");
  assert.ok(leave);
  assert.ok(GREEN90.paintFrom + GREEN90.paintDuration <= GREEN90.chipAt);
  assert.ok(GREEN90.chipAt + 1.5 <= leave.start);
});

test("the inbox's four rows fit between its line and the pinned buttons", () => {
  assert.equal(YES_ROWS.length, 4);
  assert.ok(inboxRowTop(0) >= 108 + 34 + 12, "the rows run into the line");
  const last = inboxRowTop(YES_ROWS.length - 1) + INBOX_ROWS.h;
  assert.ok(last <= INBOX_BUTTONS.top - 24, `rows end at ${last}`);
  assert.equal(INBOX_BUTTONS.top + INBOX_BUTTONS.h, PHONE_CARD.h - 28);
  const { sendBack, approve } = INBOX_BUTTONS;
  assert.equal(sendBack.left, PHONE_PAD);
  assert.ok(approve.left >= sendBack.left + sendBack.w + 12);
  assert.equal(approve.left + approve.w, PHONE_CARD.w - PHONE_PAD);
  for (const row of YES_ROWS) {
    const end = INBOX_ROWS.textLeft + row.title.length * 0.56 * 30;
    assert.ok(end <= PHONE_CARD.w - 40, row.title);
  }
});

test("each employee walks in past the card's left edge and settles at its row's left", () => {
  YES_ROWS.forEach((_, i) => {
    const path = inboxCarryPath(i);
    assert.ok(path[0].x < -40, `row ${i} starts in view`);
    assert.deepEqual(path[path.length - 1], inboxOwnerSpot(i));
    const spot = inboxOwnerSpot(i);
    assert.ok(spot.x + 34 < INBOX_ROWS.textLeft, "the ant sits on the title");
    assert.ok(
      spot.y > inboxRowTop(i) && spot.y < inboxRowTop(i) + INBOX_ROWS.h,
    );
  });
});

test("the owner's pointer comes to rest on Approve all for the click", () => {
  const keys = inboxCursorKeys(YES90);
  const atClick = keys.filter((k) => k.at <= YES90.click).pop();
  assert.ok(atClick);
  const box = {
    x: PHONE_CARD.x + INBOX_BUTTONS.approve.left,
    y: PHONE_CARD.y + INBOX_BUTTONS.top,
  };
  assert.ok(
    atClick.x > box.x + 20 && atClick.x < box.x + INBOX_BUTTONS.approve.w - 20,
  );
  assert.ok(atClick.y > box.y + 10 && atClick.y < box.y + INBOX_BUTTONS.h - 10);
  assert.equal(keys[0].at, YES90.cursorFrom);
});
