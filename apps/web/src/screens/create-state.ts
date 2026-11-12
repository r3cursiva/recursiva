// Whether the create modal is open, for which project and with which preset fields. The modal is lazy (overlays.tsx).
import type { DocJSON, IssuePatch } from "@rsva/schema/models";
import { makeAutoObservable, observableRef } from "mobx";
import type { Uploaded } from "../lib/upload.ts";
import { routeProject, router } from "../router.ts";
import { store } from "../store.ts";
import { loadDraft } from "./create-draft.ts";

/** Text the modal opens with: "new issue from selection" fills the title and, for longer text, the description. */
interface CreatePrefill {
  title: string;
  description: DocJSON | null;
  /** A saved draft's files that wait for the issue. */
  files?: Uploaded[];
}

class CreateIssue {
  open = false;
  projectId: string | null = null;
  defaults: IssuePatch = {};
  prefill: CreatePrefill | null = null;
  /** The modal opened on a saved draft. */
  restored = false;
  /** The panel fills the window. */
  expanded = false;

  constructor() {
    makeAutoObservable(this, { defaults: observableRef, prefill: observableRef });
  }

  /**
   * Opens the modal for the open project (or the first one), with fields preset, e.g. the state of a board column. A plain
   * "new issue" picks the saved draft back up, in the project it was written for; a preset opening starts from its preset.
   */
  show(defaults: IssuePatch = {}, projectId?: string, prefill: CreatePrefill | null = null): void {
    const r = router.route;
    const draft = !projectId && !prefill && Object.keys(defaults).length === 0 ? loadDraft() : null;
    this.projectId = draft?.projectId ?? projectId ?? store.projectByKey(routeProject(r) ?? "")?.id ?? store.projectList()[0]?.id ?? null;
    this.defaults = draft?.fields ?? defaults;
    this.prefill = draft ?? prefill;
    this.restored = !!draft;
    this.expanded = false;
    this.open = this.projectId !== null;
  }

  /** Another project in the modal: presets belong to the old one (a state id), so they go. */
  setProject(projectId: string): void {
    this.projectId = projectId;
    this.defaults = {};
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
  }

  close(): void {
    this.open = false;
    this.prefill = null;
  }
}

export const createIssue = new CreateIssue();
