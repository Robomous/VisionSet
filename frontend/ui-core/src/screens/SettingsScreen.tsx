/**
 * The workspace's Settings page: a header, the section navigation, and the open
 * section's groups as cards.
 *
 * Like the project screen, the open section is the host's: `ui-core` imports no
 * router, so the host spells each section's URL through `hrefFor` and turns a
 * click into a route change through `onSectionChange`. Each group names the
 * scope it belongs to, so a workspace fact is never mistaken for a preference
 * kept in this browser.
 */

import { Badge, Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@robomous/ui-core";
import type { JSX, MouseEvent, ReactNode } from "react";

import { Async } from "../data/Async";
import { DescriptionList, DescriptionRow } from "../patterns/DataDisplay";
import { SectionHeader } from "../patterns/SectionHeader";
import { useHealth } from "./settingsQueries";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settingsSections";

export interface SettingsScreenProps {
  readonly section: SettingsSection;
  /** The URL of a section, spelled by the host. Absent renders the items as buttons. */
  readonly hrefFor?: (section: SettingsSection) => string;
  readonly onSectionChange: (section: SettingsSection) => void;
}

const SECTION_LABEL: Record<SettingsSection, string> = {
  about: "About",
};

const NAV_ITEM = cn(
  "rounded-md px-2.5 py-1.5 text-left text-sm whitespace-nowrap text-muted-foreground outline-none",
  "hover:bg-muted hover:text-foreground",
  "focus-visible:ring-3 focus-visible:ring-ring/50",
  "aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground",
);

export function SettingsScreen({ section, hrefFor, onSectionChange }: SettingsScreenProps): JSX.Element {
  return (
    <div data-testid="settings-screen" className="flex flex-col gap-6">
      <SectionHeader title="Settings" description="Options and facts for this workspace." />
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav
          aria-label="Settings sections"
          data-testid="settings-nav"
          className="flex shrink-0 flex-row flex-wrap gap-0.5 md:w-44 md:flex-col"
        >
          {SETTINGS_SECTIONS.map((one) => {
            const shared = {
              "data-testid": `settings-nav-${one}`,
              "aria-current": one === section ? ("page" as const) : undefined,
              className: NAV_ITEM,
            };
            return hrefFor === undefined ? (
              <button key={one} type="button" {...shared} onClick={() => onSectionChange(one)}>
                {SECTION_LABEL[one]}
              </button>
            ) : (
              <a key={one} {...shared} href={hrefFor(one)} onClick={(event) => routed(event, () => onSectionChange(one))}>
                {SECTION_LABEL[one]}
              </a>
            );
          })}
        </nav>
        <div className="flex max-w-2xl min-w-0 flex-1 flex-col gap-5" data-testid={`settings-section-${section}`}>
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

function About(): JSX.Element {
  const health = useHealth();
  return (
    <SettingsGroup
      id="settings-about"
      title="About"
      description="The VisionSet server this browser is connected to."
      scope="Workspace"
    >
      <Async query={health} loadingRows={1}>
        {(answer) => (
          <DescriptionList title="Server">
            <DescriptionRow term="Version" data-testid="settings-version">
              {answer["version"] ?? "Not reported"}
            </DescriptionRow>
          </DescriptionList>
        )}
      </Async>
    </SettingsGroup>
  );
}

function SettingsGroup({
  id,
  title,
  description,
  scope,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly scope: string;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = `${id}-title`;
  return (
    <Card data-testid={id} role="region" aria-labelledby={headingId}>
      <CardHeader className="border-b">
        <CardTitle id={headingId} role="heading" aria-level={2} className="text-sm font-semibold">
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Badge variant="quiet">{scope}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function routed(event: MouseEvent<HTMLAnchorElement>, onNavigate: () => void): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onNavigate();
}
