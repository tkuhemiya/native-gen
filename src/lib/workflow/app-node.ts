import type { Node } from "@xyflow/react";
import type { NodeData } from "./schema";

/** React Flow canvas node carrying our discriminated `data` union. */
export type AppNode = Node<NodeData, string>;
