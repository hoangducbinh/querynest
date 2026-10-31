import { ArrowRight, Link2 } from "lucide-react";
import type {
  DatabaseSchema,
  RelationshipDefinition,
} from "../../types/schema";
export function RelationshipDetails({
  schema,
  relationship: r,
}: {
  schema: DatabaseSchema;
  relationship: RelationshipDefinition;
}) {
  const source = schema.tables.find((t) => t.id === r.sourceTable)!;
  const target = schema.tables.find((t) => t.id === r.targetTable)!;
  return (
    <div className="relationship-details">
      <span className="relationship-kind">
        <Link2 size={13} />
        {r.kind === "physical" ? "Foreign key" : "Logical relationship"}
      </span>
      <div className="relationship-endpoint">
        <small>From</small>
        <strong>{source.name}</strong>
      </div>
      <div className="relationship-endpoint">
        <small>References</small>
        <strong>{target.name}</strong>
      </div>
      <div className="relationship-mappings">
        {r.sourceColumns.map((id, index) => (
          <div key={id}>
            <span>{source.columns.find((c) => c.id === id)?.name}</span>
            <ArrowRight size={12} />
            <span>
              {
                target.columns.find((c) => c.id === r.targetColumns[index])
                  ?.name
              }
            </span>
          </div>
        ))}
      </div>
      {r.kind === "physical" && (
        <span className="relationship-behavior">
          On update / delete: NO ACTION
        </span>
      )}
    </div>
  );
}
