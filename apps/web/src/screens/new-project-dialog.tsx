// New project (PLNR-59). The navigation artboards draw its button on All projects (NavProjects) but not the form, so the
// form is built like New cycle: the workspace over the title, a large name, then the key and the tile's color, the
// workflow the project starts with, Cancel and Create (⌘↵). The key follows the name until it is typed, and is the first
// free one (keyFrom); a taken key says whose it is, as in the project's settings. The project shows at once, with its
// states (packages/sync, createProject), and opens.
import { InfoIcon } from "@phosphor-icons/react";
import { DEFAULT_WORKFLOW, cleanName, type TileColor } from "@rsva/schema/models";
import { Input } from "@rsva/ui/components/input";
import { tileTone } from "@rsva/ui/components/letter-tile";
import { TileColorPicker } from "@rsva/ui/components/tile-color-picker";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { keyFrom, keyProblem } from "../lib/project-settings.ts";
import { paths, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { submitKeys } from "./form-keys.ts";
import { newProject } from "./palette-state.ts";
import { inputFieldClass } from "./settings-fields.tsx";
import { WorkspaceIcon } from "./workspace-switcher.tsx";
import { CreateCrumb, CreateDialog, CreateFooter, CreateName } from "./create-dialog.tsx";

export const NewProjectDialog = observer(function NewProjectDialog() {
  return (
    <CreateDialog onClose={() => newProject.close()} className="md:max-w-[560px]">
      <Form />
    </CreateDialog>
  );
});

const Form = observer(function Form() {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  // The key follows the name until it is typed; clearing it hands it back to the name.
  const [keyTyped, setKeyTyped] = useState(false);
  const [color, setColor] = useState<TileColor | null>(null);
  const [tried, setTried] = useState(false);
  const projects = [...store.projects.values()];
  const shownKey = keyTyped ? key : keyFrom(name, projects);
  const problem = keyProblem(shownKey, null, projects);
  const clean = cleanName(name);
  const ok = !!clean && !problem;
  const ws = store.workspace;

  const submit = () => {
    setTried(true);
    if (!ok) return;
    const p = store.createProject({ name: clean, key: shownKey, color });
    newProject.close();
    router.push(paths.issues(currentWs(), p.key));
  };

  // A problem shows once there is something to judge: a typed key, or a try to create.
  const keyNote = problem && (keyTyped || tried) ? problem : null;
  return (
    <form {...submitKeys(submit)}>
      <CreateCrumb
        where={
          ws && (
            <>
              <WorkspaceIcon workspace={ws} current className="size-4" />
              {ws.name}
            </>
          )
        }
        title="New project"
      />
      <div className="px-5 pt-3">
        <CreateName
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={tried && !clean ? true : undefined}
          className="w-full max-md:text-xl"
          placeholder="Project name"
        />
      </div>
      <div className="flex flex-col gap-4 px-5 pt-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-project-key" className="text-caption text-ink-2">
            Key
          </label>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Input
              id="new-project-key"
              value={shownKey}
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              placeholder="KEY"
              aria-invalid={keyNote ? true : undefined}
              aria-describedby="new-project-key-note"
              onChange={(e) => {
                const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                setKey(v);
                setKeyTyped(v !== "");
              }}
              className={cn(inputFieldClass, "w-[132px] font-mono text-[13px] tracking-[0.04em] uppercase md:text-[13px]")}
            />
            <p id="new-project-key-note" className={cn("m-0 text-caption", keyNote ? "text-signal-text" : "text-ink-3")}>
              {keyNote ?? (
                <>
                  Issues read <span className="font-mono text-ink-2">{`${shownKey || "KEY"}-1`}</span>. It can change later; old links keep working.
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span aria-hidden className="text-caption text-ink-2">
            Color
          </span>
          <TileColorPicker name={shownKey || clean || "?"} value={color} autoTone={tileTone(shownKey)} label="Project color" onChange={setColor} />
        </div>
      </div>
      <div className="mx-5 mt-4 flex items-start gap-2 rounded-md border bg-ground p-3 text-caption text-ink-2">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
        <span>
          Starts with the states {DEFAULT_WORKFLOW.map((s) => s.name).join(", ")}; {DEFAULT_WORKFLOW[0]!.name} is where new issues go. Change them in
          the project’s settings.
        </span>
      </div>
      <CreateFooter note={tried && !clean ? "Name the project to continue." : "It opens once created."} onCancel={() => newProject.close()} disabled={tried && !ok}>
        Create project
      </CreateFooter>
    </form>
  );
});
