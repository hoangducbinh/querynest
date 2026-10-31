import { useMemo, useEffect, useRef } from "react";
import {
  ReactFlow,
  useNodesState,
  Panel,
  Background,
  Controls,
  Handle,
  Position,
  BaseEdge,
  getSmoothStepPath,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { KeyRound, Link2, Table2, LayoutGrid } from "lucide-react";
import { useStore } from "../schema/store";
import { Button } from "../../components/ui/button";
import { relationPositions, restoredPositions } from "./layout";
import type { TableDefinition } from "../../types/schema";
function TableNode({ data, selected }: NodeProps) {
  const table = data.table as TableDefinition;
  const schema = useStore((s) => s.workspace.schema);
  return (
    <div className={"table-node " + (selected ? "selected" : "")}>
      <div className="node-heading">
        <Table2 size={15} />
        <strong>{table.name}</strong>
      </div>
      {table.columns.map((column) => (
        <div className="node-column" key={column.id}>
          <Handle
            type="target"
            position={Position.Right}
            id={column.id}
            isConnectable={false}
          />
          {table.primaryKey.includes(column.id) ? (
            <KeyRound size={12} className="gold" />
          ) : schema.relationships.some(
              (r) =>
                r.sourceTable === table.id &&
                r.sourceColumns.includes(column.id),
            ) ? (
            <Link2 size={12} className="purple" />
          ) : (
            <span className="column-dot" />
          )}
          <span>{column.name}</span>
          <code>{column.type.toLowerCase()}</code>
          <Handle
            type="source"
            position={Position.Left}
            id={column.id}
            isConnectable={false}
          />
        </div>
      ))}
    </div>
  );
}
function RelationshipEdge(props: EdgeProps) {
  const [path] = getSmoothStepPath(props);
  return (
    <BaseEdge
      path={path}
      style={{
        stroke: props.selected ? "#007aff" : "#a6b4c8",
        strokeWidth: props.selected ? 2.3 : 1.4,
        strokeDasharray: props.data?.kind === "logical" ? "6 4" : undefined,
      }}
    />
  );
}
const nodeTypes = { table: TableNode };
const edgeTypes = { relationship: RelationshipEdge };
export function Diagram({
  select,
  selected,
}: {
  select: (id: string) => void;
  selected: string;
}) {
  const { workspace, edit } = useStore();
  const schema = workspace.schema;
  const positions = useMemo(
    () => restoredPositions(schema, workspace.diagramPositions),
    [schema, workspace.diagramPositions],
  );
  const derivedNodes = useMemo(
    () =>
      schema.tables.map((table) => ({
        id: table.id,
        type: "table",
        position: positions.get(table.id)!,
        data: { table },
        selected: table.id === selected,
      })),
    [schema.tables, positions, selected],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(derivedNodes);
  const dragging = useRef(false);
  const fit = useRef<() => void>(() => {});
  useEffect(() => {
    if (!dragging.current) setNodes(derivedNodes);
  }, [derivedNodes, setNodes]);
  function autoArrange() {
    edit((w) => {
      w.diagramPositions = Object.fromEntries(relationPositions(w.schema));
    });
    requestAnimationFrame(() => requestAnimationFrame(() => fit.current()));
  }
  const edges = schema.relationships.map((r) => ({
    id: r.id,
    type: "relationship",
    source: r.sourceTable,
    target: r.targetTable,
    sourceHandle: r.sourceColumns[0],
    targetHandle: r.targetColumns[0],
    selected:
      r.id === selected ||
      r.sourceTable === selected ||
      r.targetTable === selected,
    data: { kind: r.kind },
  }));
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable
      onNodesChange={onNodesChange}
      onInit={(instance) => {
        fit.current = () => {
          void instance.fitView({ padding: 0.2 });
        };
      }}
      onNodeDragStart={() => {
        dragging.current = true;
      }}
      onNodeDragStop={(_, node) => {
        dragging.current = false;
        edit((w) => {
          w.diagramPositions = Object.fromEntries(
            nodes.map((n) => [
              n.id,
              n.id === node.id ? { ...node.position } : { ...n.position },
            ]),
          );
        });
      }}
      nodesConnectable={false}
      edgesReconnectable={false}
      deleteKeyCode={null}
      onPaneClick={() => select("")}
      onNodeClick={(_, node) => select(node.id)}
      onEdgeClick={(_, edge) => select(edge.id)}
      fitView
      minZoom={0.25}
      maxZoom={2}
    >
      <Panel position="top-right">
        <Button className="diagram-arrange" onClick={autoArrange}>
          <LayoutGrid size={13} />
          Auto arrange
        </Button>
      </Panel>
      <Background color="var(--canvas-dot)" gap={22} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
