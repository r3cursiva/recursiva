// cn merges class names. Its tables are built from the theme in globals.css (apps/web/vite.config.ts rebuilds them), so
// it knows the type scale: `text-body` is a size, `text-ink` a color, and the later of two sizes wins.
import { createCn } from "cn/engine";
import tables from "./cn-tables.ts";

export const cn = createCn(tables);
