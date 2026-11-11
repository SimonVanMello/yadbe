//! SQL Server showplan XML: estimated (`SET SHOWPLAN_XML ON`) or actual (`SET STATISTICS XML
//! ON`). Each statement of the batch is a root; its operators (`RelOp`) are the tree.

use super::xml::{self, Element};
use super::{Draft, PlanFact, PlanFormat, QueryPlan, finish, number, show, unreadable};
use crate::db::errors::YadbeError;

const MAX_STATEMENT_CHARS: usize = 200;

/// `[dbo]` → `dbo`; a temporary table's padded name (`#a_____…_0017`) → `#a`.
fn clean(name: &str) -> String {
    let name = name
        .strip_prefix('[')
        .and_then(|n| n.strip_suffix(']'))
        .unwrap_or(name)
        .replace("]]", "]");
    if name.starts_with('#')
        && let Some(cut) = name.find("___")
    {
        return name[..cut].to_owned();
    }
    name
}

fn sub(op: &str) -> &str {
    match op {
        "EQ" => "=",
        "GT" => ">",
        "GE" => ">=",
        "LT" => "<",
        "LE" => "<=",
        "NE" => "<>",
        other => other,
    }
}

/// `id = (5)` from a seek's range columns and expressions.
fn seek_text(seek: &Element) -> Option<String> {
    let mut ranges = Vec::new();
    seek.find_all("Prefix", "RelOp", &mut ranges);
    seek.find_all("StartRange", "RelOp", &mut ranges);
    seek.find_all("EndRange", "RelOp", &mut ranges);
    let parts: Vec<String> = ranges
        .iter()
        .flat_map(|range| {
            let op = sub(range.attr("ScanType").unwrap_or("="));
            let mut columns = Vec::new();
            range.find_all("ColumnReference", "RangeExpressions", &mut columns);
            let mut values = Vec::new();
            range.find_all("ScalarOperator", "ScalarOperator", &mut values);
            columns
                .into_iter()
                .zip(values)
                .map(|(c, v)| {
                    format!(
                        "{} {op} {}",
                        c.attr("Column").unwrap_or("?"),
                        v.attr("ScalarString").unwrap_or("?")
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(" AND "))
}

fn detail(relop: &Element) -> Option<String> {
    let mut seeks = Vec::new();
    relop.find_all("SeekPredicates", "RelOp", &mut seeks);
    if let Some(text) = seeks.first().and_then(|s| seek_text(s)) {
        return Some(format!("Seek: {text}"));
    }
    for (element, label) in [
        ("Predicate", "Predicate"),
        ("ProbeResidual", "Residual"),
        ("Residual", "Residual"),
    ] {
        let mut found = Vec::new();
        relop.find_all(element, "RelOp", &mut found);
        let text = found.first().and_then(|p| {
            p.child("ScalarOperator")
                .and_then(|s| s.attr("ScalarString"))
        });
        if let Some(text) = text {
            return Some(format!("{label}: {text}"));
        }
    }
    None
}

fn relop(element: &Element, analyzed: bool) -> Draft {
    let physical = element.attr("PhysicalOp").unwrap_or("?");
    let mut draft = Draft::new(physical);
    if let Some(logical) = element.attr("LogicalOp")
        && logical != physical
    {
        draft.fact("LogicalOp", logical);
    }
    let mut objects = Vec::new();
    element.find_all("Object", "RelOp", &mut objects);
    if let Some(object) = objects.first() {
        draft.relation = object.attr("Table").map(|table| {
            let table = clean(table);
            match object.attr("Schema").map(clean) {
                Some(schema) if !table.starts_with('#') => format!("{schema}.{table}"),
                _ => table,
            }
        });
        draft.index = object.attr("Index").map(clean);
    }
    draft.detail = detail(element);
    draft.estimated_rows = element.attr("EstimateRows").and_then(number);
    draft.estimated_cost = element.attr("EstimatedTotalSubtreeCost").and_then(number);
    for key in [
        "EstimateIO",
        "EstimateCPU",
        "AvgRowSize",
        "EstimatedExecutionMode",
    ] {
        if let Some(value) = element.attr(key) {
            draft.fact(key, value);
        }
    }
    if element.attr("Parallel") == Some("1") || element.attr("Parallel") == Some("true") {
        draft.fact("Parallel", "true");
    }
    if let Some(warnings) = element.child("Warnings") {
        let names: Vec<&str> = warnings.children.iter().map(|w| w.name.as_str()).collect();
        draft.fact("Warnings", names.join(", "));
    }
    if analyzed && let Some(runtime) = element.child("RunTimeInformation") {
        let threads: Vec<&Element> = runtime
            .children
            .iter()
            .filter(|c| c.name == "RunTimeCountersPerThread")
            .collect();
        let sum = |key: &str| -> Option<f64> {
            let values: Vec<f64> = threads
                .iter()
                .filter_map(|t| t.attr(key).and_then(number))
                .collect();
            (!values.is_empty()).then(|| values.iter().sum())
        };
        let max = |key: &str| -> Option<f64> {
            threads
                .iter()
                .filter_map(|t| t.attr(key).and_then(number))
                .reduce(f64::max)
        };
        draft.actual_rows = sum("ActualRows");
        draft.loops = sum("ActualExecutions");
        let elapsed = max("ActualElapsedms");
        // Batch mode reports each operator's own time; row mode includes the children.
        if threads
            .iter()
            .any(|t| t.attr("ActualExecutionMode") == Some("Batch"))
        {
            draft.own_time = elapsed;
        }
        draft.actual_time_ms = elapsed;
        if let Some(reads) = sum("ActualLogicalReads") {
            draft.fact("ActualLogicalReads", show(reads));
        }
        if let Some(cpu) = max("ActualCPUms") {
            draft.fact("ActualCPUms", show(cpu));
        }
    }
    let mut children = Vec::new();
    for child in &element.children {
        child_relops(child, &mut children);
    }
    draft.children = children.into_iter().map(|c| relop(c, analyzed)).collect();
    draft
}

/// The `RelOp`s directly under an operator (inside its operator-specific element).
fn child_relops<'a>(element: &'a Element, out: &mut Vec<&'a Element>) {
    if element.name == "RelOp" {
        out.push(element);
        return;
    }
    for child in &element.children {
        child_relops(child, out);
    }
}

fn statement(stmt: &Element, analyzed: bool, summary: &mut Vec<PlanFact>) -> Draft {
    let mut draft = Draft::new(stmt.attr("StatementType").unwrap_or("STATEMENT"));
    draft.detail = stmt.attr("StatementText").map(|text| {
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.chars().count() > MAX_STATEMENT_CHARS {
            let cut: String = text.chars().take(MAX_STATEMENT_CHARS).collect();
            format!("{cut}…")
        } else {
            text
        }
    });
    draft.estimated_rows = stmt.attr("StatementEstRows").and_then(number);
    draft.estimated_cost = stmt.attr("StatementSubTreeCost").and_then(number);
    if let Some(reason) = stmt.attr("StatementOptmEarlyAbortReason") {
        draft.fact("StatementOptmEarlyAbortReason", reason);
    }
    if let Some(plan) = stmt.child("QueryPlan") {
        for key in [
            "DegreeOfParallelism",
            "MemoryGrant",
            "CompileTime",
            "CompileCPU",
        ] {
            if let Some(value) = plan.attr(key) {
                summary.push(PlanFact::new(key, value));
            }
        }
        if let Some(times) = plan.child("QueryTimeStats") {
            for key in ["ElapsedTime", "CpuTime"] {
                if let Some(value) = times.attr(key) {
                    summary.push(PlanFact::new(key, format!("{value} ms")));
                }
            }
            if analyzed {
                draft.actual_time_ms = times.attr("ElapsedTime").and_then(number);
            }
        }
        if let Some(missing) = plan.child("MissingIndexes") {
            let mut groups = Vec::new();
            missing.find_all("MissingIndexGroup", "", &mut groups);
            for group in groups {
                if let Some(impact) = group.attr("Impact") {
                    summary.push(PlanFact::new("MissingIndex", format!("impact {impact}%")));
                }
            }
        }
        if let Some(root) = plan.child("RelOp") {
            draft.children.push(relop(root, analyzed));
        }
    }
    if let Some(cost) = draft.estimated_cost {
        summary.push(PlanFact::new("StatementSubTreeCost", show(cost)));
    }
    draft
}

pub(super) fn parse(documents: &[String], analyzed: bool) -> Result<QueryPlan, YadbeError> {
    let mut roots = Vec::new();
    let mut summary = Vec::new();
    for document in documents {
        let root = xml::parse(document)
            .ok_or_else(|| unreadable("SQL Server", "the showplan XML is not well formed"))?;
        let mut statements = Vec::new();
        root.find_all("StmtSimple", "", &mut statements);
        for stmt in statements {
            roots.push(statement(stmt, analyzed, &mut summary));
        }
    }
    if roots.is_empty() {
        return Err(unreadable("SQL Server", "no statement in the showplan"));
    }
    Ok(finish(
        PlanFormat::ShowplanXml,
        analyzed,
        roots,
        summary,
        documents.join("\n\n"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::plan::PlanWeightBasis;

    #[test]
    fn reads_an_actual_plan() {
        let plan = parse(
            &[include_str!("fixtures/mssql_actual.xml").to_owned()],
            true,
        )
        .expect("plan");
        assert_eq!(plan.weight_basis, PlanWeightBasis::Time);
        assert_eq!(plan.nodes[0].operation, "SELECT");
        assert!(
            plan.nodes[0]
                .detail
                .as_deref()
                .is_some_and(|d| d.starts_with("SELECT TOP 10"))
        );
        assert_eq!(plan.nodes[1].operation, "Sort");
        assert_eq!(plan.nodes[1].actual_rows, Some(10.0));
        let scans: Vec<&str> = plan
            .nodes
            .iter()
            .filter_map(|n| n.relation.as_deref())
            .collect();
        assert!(scans.contains(&"#a") && scans.contains(&"#b"), "{scans:?}");
        assert!(plan.summary.iter().any(|f| f.label == "ElapsedTime"));
        for node in &plan.nodes {
            if let Some(parent) = node.parent {
                assert_eq!(plan.nodes[parent as usize].depth + 1, node.depth);
            }
        }
    }

    #[test]
    fn reads_every_statement_of_an_estimated_batch() {
        let plan = parse(
            &[include_str!("fixtures/mssql_estimated.xml").to_owned()],
            false,
        )
        .expect("plan");
        let roots: Vec<&PlanNodeRef> = plan.nodes.iter().filter(|n| n.parent.is_none()).collect();
        assert_eq!(roots.len(), 2);
        assert_eq!(plan.weight_basis, PlanWeightBasis::Cost);
        assert!(plan.nodes.iter().all(|n| n.actual_rows.is_none()));
        let seek = plan
            .nodes
            .iter()
            .find(|n| n.operation.contains("Seek"))
            .expect("seek");
        assert!(
            seek.detail
                .as_deref()
                .is_some_and(|d| d.starts_with("Seek: ")),
            "{seek:?}"
        );
        assert!(seek.index.is_some());
    }

    type PlanNodeRef = crate::db::plan::PlanNode;

    #[test]
    fn cleans_temporary_table_names() {
        assert_eq!(clean("[#a_______________000017]"), "#a");
        assert_eq!(clean("[dbo]"), "dbo");
        assert_eq!(clean("[a]]b]"), "a]b");
    }
}
