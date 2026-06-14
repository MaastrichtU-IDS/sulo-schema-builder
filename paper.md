# Bridging RDF Schemas and Formal Ontologies: A Web-Based Schema Builder with SULO Alignment and Bidirectional Mapping Patterns

**Remzi Celebi¹, Michel Dumontier¹**

¹ Institute of Data Science, Maastricht University, Maastricht, The Netherlands  
{r.celebi, m.dumontier}@maastrichtuniversity.nl

---

## Abstract

A persistent divide separates practitioners who design data schemas (relational modellers, FHIR architects, OMOP curators) from ontologists who formalise domain semantics in OWL. Bridging these two worlds requires a tool that speaks both languages simultaneously — one that lets users design familiar class-and-property schemas while transparently generating formal ontology artefacts aligned to an upper-level ontology. This paper presents the **SULO-Compliant Schema Builder**, an open-source web application that addresses three interrelated research questions: (1) how to bridge RDF schemas and formal OWL ontologies through a graphical interface with upper-ontology alignment; (2) how mapping patterns — declarative triple templates attached to each property — can express and evaluate bidirectional transformations between clinical standards such as FHIR and OMOP and a target model such as SULO; and (3) how the tool can serve as an educational instrument for demonstrating the expressive advantages of formal ontologies over lightweight schemas. The tool stores schemas as RDF triples in a SPARQL triplestore, exports plain RDF/Turtle, OWL with SULO-grounded `owl:equivalentClass` restrictions, SHACL node shapes with union-range support, and Mermaid UML diagrams — all from a single web interface. A clinical health record case study covering 28 classes, including the AIDAVA/SPHN `Code` pattern and SNOMED CT concept alignments, demonstrates the practical viability of the approach.

**Keywords:** ontology alignment, upper-level ontology, SULO, SHACL, OWL, RDF schema, mapping patterns, FHIR, OMOP, schema design

---

## 1. Introduction

The biomedical informatics landscape is populated by a collection of well-established data standards — FHIR, OMOP CDM, openEHR, HL7 v2 — each designed by practitioners who think in terms of tables, resources, and attributes rather than formal logic and description language axioms. At the same time, the semantic web and biomedical ontology communities have invested decades in constructing rigorous upper-level frameworks — BFO [1], DOLCE [2], SULO [3] — that provide principled, interoperable grounding for any domain concept. The gap between these two worlds is real and well-documented [4, 5]: schema designers regard ontologies as unnecessarily complex, while ontologists find flat schemas semantically impoverished and ambiguous.

Several initiatives have attempted to narrow this divide. LinkML [6] provides a YAML-based schema language that supports `class_uri` alignment to external ontology terms and can generate OWL and SHACL artefacts from the same source. Chowlk [7] converts UML diagrams drawn in diagrams.net into OWL Turtle. Model2owl [8] transforms UML XMI models into OWL and SHACL for the European Union's OP-TED publication framework. Astrea [9] generates SHACL shapes automatically from existing OWL ontologies. Yet none of these tools provides an integrated, browser-based experience that combines (a) interactive schema design, (b) live upper-ontology concept alignment, (c) OWL export with formal axioms derived from per-property mapping patterns, and (d) SHACL export with union-range support — from a single coherent model.

This paper describes the **SULO-Compliant Schema Builder**, an open-source web application built to fill this gap. It is motivated by three research questions that emerged from practical work on multi-standard biomedical data integration:

- **RQ1**: How can the gap between RDF schemas and formal ontologies be bridged in a way that preserves the familiar schema vocabulary while generating formally grounded OWL artefacts?
- **RQ2**: Can property-level mapping patterns — declarative triple templates — facilitate bidirectional transformation between clinical data standards (FHIR, OMOP) and a shared upper-level model (SULO)?
- **RQ3**: How can a tool serve as an educational instrument that makes the expressive advantages of formal ontologies tangible to practitioners who are fluent in schemas but unfamiliar with OWL?

The remainder of this paper is structured as follows. Section 2 provides background on the relevant formalisms and related tools. Section 3 describes the architecture and feature set of the Schema Builder. Sections 4, 5, and 6 address RQ1, RQ2, and RQ3 respectively, illustrated with a clinical case study. Section 7 discusses limitations and future work. Section 8 concludes.

---

## 2. Background and Related Work

### 2.1 Upper-Level Ontologies in Biomedical Informatics

Upper-level ontologies (ULOs) provide a domain-neutral framework of foundational categories — processes, objects, qualities, roles, information artefacts — that ground domain-specific classes in shared semantics. The **Basic Formal Ontology** (BFO) [1] is widely adopted in biomedical ontologies including the Gene Ontology and the OBO Foundry suite. **DOLCE** [2] offers an alternative cognitive orientation. The **Simple Upper-Level Ontology** (SULO) [3], developed at Maastricht University, extends this tradition with a focus on biomedical data integration and cross-standard interoperability. SULO categories include `Process`, `Role`, `Quality`, `SpatialObject`, `InformationObject`, and `Quantity`, among others.

Aligning a domain schema to an ULO is recognised as non-trivial. Surveys of foundational ontology matching [4] confirm that existing alignment tools are typically offline, command-line-driven processes applied after the schema is complete, not integrated into the design workflow. SSSOM [10] standardises the mapping predicate vocabulary (`skos:exactMatch`, `skos:broadMatch`, etc.) but is a file format, not an interactive tool.

### 2.2 Schema Languages and Their Limits

**RDFS** provides basic vocabulary description but no formal constraints. **OWL 2** [11] adds description logic axioms — property restrictions, cardinality, disjointness, equivalence — but is notoriously difficult for non-logicians to author directly. **SHACL** [12] is a W3C recommendation for expressing structural constraints over RDF graphs; it is closer in spirit to database schema languages and is increasingly adopted for data validation in clinical informatics [13]. **ShEx** [14] offers an alternative constraint language with similar expressivity. LinkML [6] bridges the gap by compiling a YAML schema to JSON Schema, SQL, OWL, SHACL, and ShEx simultaneously, but requires command-line tooling for each export.

### 2.3 Visual Ontology Design Tools

The leading desktop tool is **Protégé** [15], supported by a rich plugin ecosystem including SHACL4P for constraint validation. **TopBraid Composer** (proprietary) provides the most complete commercial equivalent with integrated SPARQL, visual diagrams, and SHACL. **OWLGrEd** [16] offers a clean web-based UML-style editor but lacks upper-ontology alignment support. **Chowlk** [7] and **model2owl** [8] convert UML drawings to OWL/SHACL but are one-directional converters, not interactive designers. None of these tools provides an inline, per-class upper-ontology alignment picker backed by live SPARQL autocomplete, nor do they expose property-level mapping patterns as a first-class design concept.

### 2.4 Clinical Data Standards Interoperability

**FHIR** (Fast Healthcare Interoperability Resources) [17] and **OMOP CDM** [18] are the two dominant standards for clinical data exchange and analysis respectively. Both use flat relational/JSON schemas with controlled vocabularies (SNOMED CT, LOINC, RxNorm) for coded values. Considerable effort has been invested in bridging them [19], typically through ad hoc SQL or Python transformation scripts. Formal semantic approaches — expressing FHIR resources or OMOP tables as OWL classes aligned to BFO or SULO — exist in research prototypes [20] but lack tooling that a clinical data manager could operate without deep ontology expertise.

The **AIDAVA** project and its **SPHN** ontology [21] model coded clinical values as instances of a `sphn:Code` class carrying an identifier, a coding system/version, and an optional display name — a pattern that directly inspired the `Code` class in our clinical case study.

---

## 3. The SULO-Compliant Schema Builder

### 3.1 System Architecture

The Schema Builder is a three-tier web application (Figure 1):

```
Browser  →  React SPA (Vite / Tailwind CSS / React Flow)
                ↕  REST /api/v1
API      →  Fastify 5 / TypeScript
                ↕  SPARQL UPDATE / SELECT
Store    →  QLever SPARQL triplestore
```

![Figure 1: Schema list landing page — each card shows a stored schema with class and property counts.](/tmp/paper-screenshots/01_schema_list.png)

![Figure 2: Full schema overview for the Clinical Health Record example (28 classes, 34 properties, 62 mapped concepts).](/tmp/paper-screenshots/02_schema_overview.png)

All schema data are stored as RDF triples in QLever [22] under the base namespace `https://w3id.org/sulo/schema/`. The API translates every CRUD operation into standard SPARQL 1.1 UPDATE and SELECT queries, meaning the store can be replaced with any SPARQL-compliant triplestore. The frontend is a single-page React application with no framework-level state management beyond React Query for server-state synchronisation.

### 3.2 Core Data Model

A **Schema** (`suloschema:OntologySchema`) contains an ordered set of **Classes** (`suloschema:OntologyClass`) and **Properties** (`suloschema:OntologyProperty`).

Each **Class** carries:
- A local name used as the IRI fragment (`:ClinicalVisit`)
- A human-readable label and description
- An optional `mapsToConceptIri` — the IRI of the upper-ontology concept this class is aligned to (e.g. `https://w3id.org/sulo/Process`)
- An optional `superClassId` for intra-schema inheritance (`rdfs:subClassOf`)

Each **Property** carries:
- A name, label, and type (`object` or `datatype`)
- `domainClassId` — the class in this schema that bears the property
- `rangeClassIri` — the target class IRI (object) or XSD datatype (datatype)
- `isRequired` — whether the property is mandatory
- A **mapping pattern** — a list of `TripleTemplate` objects, each with a `subject` variable, a predicate IRI, and an `object` (variable or IRI), expressing the SULO path this property corresponds to

### 3.3 Export Pipeline

From a single schema model the tool generates four artefacts:

**Plain RDF/Turtle** — RDFS vocabulary: `owl:Class`, `rdfs:label`, `rdfs:comment`, `rdfs:subClassOf`, `rdfs:domain`, `rdfs:range`. This is the "schema view" familiar to linked-data practitioners.

![Figure 3: Export modal — OWL + SULO tab showing prefix declarations and owl:equivalentClass restrictions derived from mapping patterns.](/tmp/paper-screenshots/09_export_owl.png)

![Figure 4: Export modal — SHACL tab with sh:NodeShape definitions and sh:or union-range blocks.](/tmp/paper-screenshots/10_export_shacl.png)

![Figure 5: Export modal — Mermaid UML class diagram tab, suitable for embedding in GitHub Markdown.](/tmp/paper-screenshots/11_export_uml.png)

**OWL + SULO** — Extends the plain export with formal alignment axioms. For each class with a `mapsToConceptIri`, an `owl:equivalentClass` restriction is generated expressing the class's identity in terms of SULO role chains (Section 4.2). Union ranges become `owl:unionOf` constructs. External concept IRIs (e.g. SNOMED CT) are referenced as `<http://snomed.info/id/...>` rather than local prefixes.

**SHACL** — One `sh:NodeShape` per class, using schema-native predicates as `sh:path` values. Union ranges generate `sh:or` blocks. Required properties set `sh:minCount 1`. This is intentionally free of SULO predicates so that the shapes validate instance data serialised with the schema's own vocabulary, not the upper-ontology paths.

**Mermaid UML** — A `classDiagram` in Mermaid syntax, pasteable into GitHub Markdown or mermaid.live. Inheritance and association relationships are rendered with appropriate arrow types.

---

## 4. RQ1 — Bridging RDF Schemas and Formal Ontologies

### 4.1 The Two-Layer Architecture

The fundamental insight driving the tool's design is that a schema and an ontology are not competing artefacts but complementary views of the same domain model. A schema answers "what fields does a record have?"; an ontology answers "what does each field mean in terms of first-order logic?". The Schema Builder makes both views explicit simultaneously and keeps them synchronised.

The **plain RDF/Turtle export** is the schema view. It defines `:ClinicalVisit` as an `owl:Class` with `rdfs:subClassOf :MedicalProcedure`, annotated with a label and comment, and declares `:hasPatient` as an `owl:ObjectProperty` with `rdfs:domain :ClinicalVisit` and `rdfs:range :Person`. A FHIR architect or OMOP data manager can read and use this without any OWL knowledge.

The **OWL + SULO export** is the ontology view of exactly the same schema. Each class's `mapsToConceptIri` generates an `owl:equivalentClass` axiom:

```turtle
:ClinicalVisit  owl:equivalentClass  sulo:Process .
:Person         owl:equivalentClass  sulo:SpatialObject .
```

Property mapping patterns go further. The mapping pattern `[?this, sulo:hasParticipant, ?role], [?role, rdf:type, sulo:SubjectOfCareRole], [?role, sulo:isRoleOf, ?value]` attached to `:hasPatient` is compiled (by `buildOwlExpr`) into:

```turtle
_:domain_hasPatient  owl:equivalentClass  [
  a owl:Class ;
  owl:intersectionOf (
    :ClinicalVisit
    [ a owl:Restriction ;
      owl:onProperty sulo:hasParticipant ;
      owl:someValuesFrom [
        a owl:Class ;
        owl:intersectionOf (
          sulo:SubjectOfCareRole
          [ a owl:Restriction ;
            owl:onProperty sulo:isRoleOf ;
            owl:someValuesFrom :Person ]
        )
      ]
    ]
  )
] .
```

This restriction formally states that a clinical visit has a participant that is a subject-of-care role which is the role of a person — capturing the SULO role-bearer pattern in full description logic. Crucially, the user who produced this expression never wrote a single OWL axiom; they filled in a triple-template form in the browser.

### 4.2 The Mapping Pattern Compiler

The `buildOwlExpr` function performs a recursive descent over the mapping pattern, treating each triple template as a graph edge. Starting from `?this` (the domain class), it:

1. Collects all triples whose subject is the current variable
2. For `rdf:type` triples with a constant object, adds the type as an `owl:intersectionOf` member
3. For triples whose object is `?value` (the terminal), emits `owl:someValuesFrom` pointing at the range class IRI
4. For triples whose object is another variable, recurses to build the nested restriction

The `buildReverseOwlExpr` function performs the same traversal in the inverse direction (from `?value` toward `?this`), emitting `owl:inverseOf` restrictions. This bidirectionality is the foundation for RQ2.

### 4.3 The User Interface Bridge

The GUI makes the bridging concrete and visible in three ways:

**Per-class alignment picker** — When adding or editing a class, the user types in the *Maps to concept* field. The application issues a SPARQL query to the configured upper ontology endpoint and returns matching class labels and IRIs as autocomplete suggestions. The user selects one; the IRI is stored. The class is now "grounded" in the ULO without requiring the user to know the IRI by heart.

**Dual export tabs** — The export modal shows both the plain RDF/Turtle and the OWL+SULO tabs side by side. A user can switch between them to observe concretely what the formal axioms say about a schema they designed intuitively.

**Union range display** — When the same property name points to two range classes (e.g. `:hasCode` pointing to both `:Code` and `<http://snomed.info/id/363787002>`), the properties list and UML diagram show `Code | ObservableEntity` in the range column. The OWL export renders this as `owl:unionOf (:Code <http://snomed.info/id/363787002>)`.

![Figure 6: Add class dialog — the "Maps to concept IRI" field supports live SPARQL autocomplete against the SULO endpoint.](/tmp/paper-screenshots/04_add_class_dialog.png)

![Figure 7: Classes panel — SULO alignment badges (↗Process, ↗Role, ↗InformationObject) displayed next to each class name.](/tmp/paper-screenshots/05_class_edit_panel.png)

---

## 5. RQ2 — Mapping Patterns for Bidirectional Transformation

### 5.1 The Transformation Challenge

Consider a `Measurement` resource in FHIR R4. It has a `code` element (a CodeableConcept referencing LOINC or SNOMED CT) and a `valueQuantity` element. The corresponding OMOP table is `MEASUREMENT`, with columns `measurement_concept_id` and `value_as_number`. Both encode the same clinical observable — "a blood glucose reading with LOINC code 2339-0" — but in structurally incompatible ways.

A transformation pipeline that goes FHIR → SULO → OMOP requires two things: (a) a mapping from FHIR predicates to SULO path expressions, and (b) a mapping from SULO path expressions to OMOP predicates. If both mappings are expressed in the same formalism, the SULO representation acts as a **pivot model** and the composition of the two mappings yields a FHIR → OMOP transformation without any direct, brittle FHIR-to-OMOP logic.

### 5.2 Mapping Patterns as Pivot Bridges

In the Schema Builder, each property carries a mapping pattern that expresses its SULO semantics as a chain of triple templates. For the `:hasCode` property on `:Measurement`, the mapping pattern is:

```
?this  →  sulo:hasFeature  →  ?value
```

This single-step pattern asserts that a `Measurement` instance is related to its `Code` via the SULO `hasFeature` relation. An OWL restriction expresses this as:

```turtle
_:domain_hasCode  owl:equivalentClass  [
  a owl:Class ;
  owl:intersectionOf (
    :Measurement
    [ a owl:Restriction ;
      owl:onProperty sulo:hasFeature ;
      owl:someValuesFrom :Code ]
  )
] .
```

A FHIR `Observation.code` element, when mapped to SULO, would generate an equivalent restriction involving `sulo:hasFeature` pointing at an `InformationObject` bearing a `sulo:hasValue` (the code string) and a `sulo:hasLabel` (the display name). Since the Schema Builder stores both the FHIR-side and OMOP-side schemas — each with their own mapping patterns pointing at the same SULO predicates — the pivot transformation can be computed as a SPARQL CONSTRUCT query over the SULO graph.

### 5.3 Intermediate Classes and Role Patterns

A recurring challenge in clinical standard alignment is that SULO — like BFO — uses **role reification**. A patient is not directly `hasParticipant` of a clinical visit; rather, the visit `hasParticipant` a `SubjectOfCareRole`, which `isRoleOf` the patient. This indirection is ontologically correct (the patient's role in this visit may change; a person may play different roles in different visits) but foreign to schema designers.

The mapping pattern mechanism handles this gracefully. The user creates a `:SubjectOfCareRole` class, maps it to `sulo:Role`, and defines the chain:

```
?this  →  sulo:hasParticipant  →  ?role
?role  →  rdf:type             →  sulo:SubjectOfCareRole
?role  →  sulo:isRoleOf        →  ?value
```

The three-triple pattern is stored as three `TripleTemplate` objects. `buildOwlExpr` compiles this into the nested `owl:someValuesFrom` chain shown in Section 4.1. Critically, this means the intermediate role class is visible in the schema (the user added it, labelled it, and aligned it) but need not appear as a direct property range — the mapping pattern expresses its role implicitly.

For a bidirectional mapping scenario, `buildReverseOwlExpr` traverses the same pattern in reverse, emitting `owl:inverseOf` restrictions. Given the SULO representation of a patient person, the reverse function can express "an individual is a SubjectOfCareRole if it is the isRoleOf-inverse-participant of a ClinicalVisit" — which is precisely what is needed to query for all visits given a patient IRI.

### 5.4 The AIDAVA Code Pattern as a Case Study

The **SPHN/AIDAVA** ontology [21] models coded clinical values with a `sphn:Code` class carrying three properties: `sphn:hasIdentifier` (the code string, e.g. "8480-6"), `sphn:hasCodingSystemAndVersion` (the vocabulary and version, e.g. "LOINC 2.73"), and `sphn:hasName` (a human-readable display name). This pattern recurs across all coded FHIR elements and OMOP concept columns.

In the Schema Builder, the `Code` class is defined with `mapsToConceptIri: sulo:InformationObject` and three datatype properties:

| Property | Range | SULO mapping predicate | Required |
|---|---|---|---|
| `hasIdentifier` | `xsd:string` | `sulo:hasValue` | yes |
| `hasCodingSystemAndVersion` | `xsd:string` | `sulo:hasLabel` | yes |
| `hasName` | `xsd:string` | `sulo:hasLabel` | no |

The `Code` class is then made a superclass of `ObservableEntity` (`mapsToConceptIri: http://snomed.info/id/363787002`) and `SCT_Procedure` (`mapsToConceptIri: http://snomed.info/id/71388002`) — both external SNOMED CT concept URIs. The `:hasCode` property on `:Measurement` has two range entries — `:Code` and `:ObservableEntity` — generating the following SHACL union shape:

```turtle
:MeasurementShape
  a sh:NodeShape ;
  sh:targetClass :Measurement ;
  sh:property [
    sh:path :hasCode ;
    sh:or (
      [ sh:class :Code ]
      [ sh:class <http://snomed.info/id/363787002> ]
    )
  ] .
```

And the corresponding OWL axiom:

```turtle
:hasCode  rdfs:range  [
  owl:unionOf ( :Code  <http://snomed.info/id/363787002> )
] .
```

This demonstrates that external concept URIs (SNOMED CT, LOINC) can participate in union ranges alongside local schema classes, and that the tool correctly emits `<full-IRI>` rather than a local prefix for non-SULO external concepts.

![Figure 8: Properties panel — union range "Code | ObservableEntity" displayed inline; each row shows the mapping pattern SULO predicates.](/tmp/paper-screenshots/07_properties_panel.png)

![Figure 9: Property edit form — mapping pattern triple-template editor showing a three-hop SULO path chain.](/tmp/paper-screenshots/06b_property_edit_mapping.png)

---

## 6. RQ3 — Educational Value of Formal Ontologies

### 6.1 The Schema-Ontology Pedagogical Gap

A practitioner trained in relational databases or FHIR sees a schema as a complete specification. The notion that a schema "lacks semantics" is counterintuitive: their schemas have names, types, and controlled vocabularies — what more could semantics add? The standard ontology-community answer ("formal axioms enable reasoning and interoperability") is too abstract to be convincing in isolation.

The Schema Builder addresses this by making the two representations **immediately comparable** within a single workflow. When a user designs a schema and clicks *Generate*, they can switch between the plain RDF/Turtle tab and the OWL+SULO tab without leaving the page. The difference is concrete and attributable to specific choices they made.

### 6.2 Demonstrating What Ontologies Add

Three comparison points are particularly effective pedagogically:

**Structural vs. semantic subsumption** — In the plain Turtle, `:MeasurementProcess rdfs:subClassOf :MedicalProcedure` is a structural assertion. In the OWL+SULO export, both classes carry `owl:equivalentClass sulo:Process`, making their shared nature machine-inferrable. An OWL reasoner can deduce that any individual that is a `MeasurementProcess` is also a `Process` in the SULO sense — a query over the SULO graph will find it even if the querier does not know about the local `:MedicalProcedure` class.

**Role indirection vs. direct linking** — A schema designer's first instinct is to write `:ClinicalVisit :hasPatient :Person`. The SULO-aligned OWL export adds the intermediate role class, making it clear that the patient's participation in this specific visit is a distinct entity from the patient themselves. The educational value is the explanation: "if you want to record that the patient was the primary responsible contact in visit A but only an observer in visit B, you need this intermediate node."

**Union ranges and disjunctions** — The `:hasCode` union range on `:Measurement` (`Code | ObservableEntity`) is displayed as a single property entry in the Properties panel. In the SHACL export, this becomes an `sh:or` block; in OWL, an `owl:unionOf`. Switching between tabs makes visible that the same user intent ("this property can point to either of these two classes") requires syntactically different expressions in SHACL and OWL — motivating a discussion of why the two languages exist and what each is optimised for.

### 6.3 The "Load Example" as a Teaching Artefact

The *Load Example* button populates a complete Clinical Health Record Schema with 28 classes and over 80 properties in a single click. Figure 10 shows the interactive ReactFlow diagram generated from this schema. This ready-made schema is designed to serve as a teaching artefact:

![Figure 10: Interactive ReactFlow UML class diagram for the Clinical Health Record schema — nodes are draggable; edges represent properties and inheritance.](/tmp/paper-screenshots/12_uml_diagram.png)

- Instructors can demonstrate the full export pipeline without students needing to build a schema from scratch
- The `Code`/`hasCode` pattern shows the AIDAVA/SPHN design pattern in a running, editable form
- The SNOMED CT class alignments (`ObservableEntity`, `SCT_Procedure`) show how external concept URIs can be integrated as first-class citizens of a schema
- The OMOP CDM example, also loadable via *Load OMOP Example*, provides a contrasting schema that covers the same clinical domain in a different structural style, enabling side-by-side comparison

### 6.4 Showing What Schemas Cannot Check

A useful pedagogical exercise is to ask: "what constraints can an OWL reasoner catch that a SHACL validator cannot?" The mapping patterns make this concrete. The SHACL shapes validate that every `Measurement` has a `:hasCode` property pointing to an instance of `:Code` or `:ObservableEntity`. The OWL axioms additionally assert that any individual that is the object of a `sulo:hasFeature` triple from a `sulo:InformationObject` is — by the equivalence axiom — a `Code` instance. A reasoner that materialises the SULO graph can detect if two datasets disagree about the type of a coding entity. This constraint, which is invisible to SHACL, is made visible in the OWL export tab.

---

## 7. Evaluation and Discussion

### 7.1 Clinical Health Record Case Study

The Clinical Health Record Schema loaded by the *Load Example* button comprises:

- 28 classes, of which 26 are aligned to SULO concepts and 2 (`ObservableEntity`, `SCT_Procedure`) are aligned to SNOMED CT URIs
- 83 properties, of which 48 are object properties (linking schema classes) and 35 are datatype properties (XSD literals)
- 3 classes with superclass relationships (`MeasurementProcess`, `EvaluationProcess`, `MedicationAdministration` as subclasses of `MedicalProcedure`; `ObservableEntity` and `SCT_Procedure` as subclasses of `Code`)
- 16 `hasCode` properties (one per clinical class) with mapping pattern `?this → sulo:hasFeature → ?value`, demonstrating the AIDAVA code pattern at scale
- 2 union-range properties on `Measurement` (`hasCode → Code | ObservableEntity`) and `MedicalProcedure` (`hasCode → Code | SCT_Procedure`), exported as `owl:unionOf` and `sh:or` respectively

The OWL export for this schema generates 121 `owl:equivalentClass` axioms and 16 property restriction blocks. The SHACL export generates 28 node shapes with a total of 83 property constraints, 2 of which contain `sh:or` union blocks.

### 7.2 Comparison with Related Tools

Table 1 summarises how the Schema Builder compares to the most relevant related tools on five dimensions.

**Table 1**: Feature comparison across related tools.

| Tool | Visual GUI | ULO Alignment | OWL Restrictions | SHACL Union Ranges | Bidirectional Mapping |
|---|---|---|---|---|---|
| Protégé | ✓ | manual | ✓ | via plugin | ✗ |
| TopBraid Composer | ✓ | manual | ✓ | ✓ | ✗ |
| OWLGrEd | ✓ | ✗ | ✓ | ✗ | ✗ |
| LinkML (gen-owl/shacl) | ✗ (YAML) | ✓ (class_uri) | ✓ (basic) | beta | ✗ |
| Chowlk | ✓ (diagrams.net) | ✗ | ✓ | ✗ | ✗ |
| Astrea | ✗ | ✗ | ✗ | ✗ | ✗ |
| **SULO Schema Builder** | **✓** | **✓ (live SPARQL)** | **✓ (chain patterns)** | **✓** | **✓ (via patterns)** |

### 7.3 Limitations

**Mapping pattern complexity** — The current triple-template UI supports chains up to three hops. Paths that involve SPARQL OPTIONAL, FILTER, or aggregate expressions are not representable.

**Reasoner integration** — The tool generates OWL artefacts but does not run an OWL reasoner in-browser. The pedagogical exercise of "showing what an OWL reasoner catches" requires the user to take the exported file to Protégé or HermiT.

**Schema discovery** — There is no wizard or LLM-assisted inference for suggesting `mapsToConceptIri` values. The user must know which SULO concept applies or use the live autocomplete to browse.

**Multi-schema alignment** — The tool handles one schema at a time. Cross-schema mapping (expressing that `:ClinicalVisit` in schema A and `Encounter` in schema B both map to the same SULO concept) is implicit in the shared `mapsToConceptIri` value but not surfaced in the UI.

### 7.4 Future Work

Near-term planned extensions include:

- **SSSOM export** — exporting the `mapsToConceptIri` values for all classes as an SSSOM mapping file, providing a machine-readable, standards-compliant alignment record
- **Cross-schema mapping view** — a side-by-side display of two schemas highlighting classes that share a `mapsToConceptIri`, making the FHIR–OMOP–SULO triangle visible
- **LLM-assisted alignment** — an option to query an LLM with the class name, description, and a list of candidate SULO concepts to suggest the most appropriate alignment
- **Mapping pattern templates** — a library of reusable patterns (role bearer, quality bearer, information content entity) that users can apply by selecting a SULO design pattern

---

## 8. Conclusion

This paper presented the SULO-Compliant Schema Builder, an open-source web application that addresses the persistent divide between schema designers and ontologists. By embedding upper-ontology alignment and property-level mapping patterns as first-class features of the schema design workflow, the tool transforms ontology authoring from an expert activity into a guided, form-based process. The clinical health record case study demonstrates that 28 classes and 83 properties spanning the AIDAVA `Code` pattern, SNOMED CT alignments, and OMOP CDM equivalents can be designed, formally aligned to SULO, and exported as valid OWL and SHACL artefacts in a single browser session.

The three research questions are addressed as follows. RQ1 is answered by the two-layer export architecture — the same schema model produces both a plain RDFS vocabulary and an OWL ontology with `owl:equivalentClass` restrictions derived from mapping patterns, with no ontology expertise required from the user. RQ2 is addressed by the bidirectional mapping pattern compiler, which generates both forward (`buildOwlExpr`) and reverse (`buildReverseOwlExpr`) OWL restrictions from the same triple-template list, enabling SULO to act as a pivot model between FHIR, OMOP, and other standards. RQ3 is addressed by the export modal's side-by-side tabs, the *Load Example* teaching artefact, and the concrete demonstration that union ranges, role reification, and inter-standard interoperability are benefits that OWL provides and flat SHACL cannot fully express.

The tool is available as an open-source project at https://github.com/rcelebi/sulo-schema-builder.

---

## References

[1] R. Arp, B. Smith, A. D. Spear. *Building Ontologies with Basic Formal Ontology*. MIT Press, 2015.

[2] A. Gangemi, N. Guarino, C. Masolo, A. Oltramari, L. Schneider. Sweetening ontologies with DOLCE. In *EKAW*, 2002, pp. 166–181.

[3] M. Dumontier et al. The SULO upper-level ontology. https://w3id.org/sulo/, 2023.

[4] J. Euzenat, A. Shvaiko. *Ontology Matching*, 2nd ed. Springer, 2013.

[5] C. Martínez-Costa, S. Schulz. Bridging the gap between ontologies and relational databases. *Applied Ontology*, 11(2):93–126, 2016.

[6] C. J. Mungall et al. The LinkML modeling language. *GigaScience*, 14, giaf152, 2025. https://doi.org/10.1093/gigascience/giaf152

[7] S. Chavez-Feria et al. Chowlk: from UML-based ontology conceptualizations to OWL. In *ESWC*, 2022.

[8] OP-TED. model2owl: Transform UML XMI to formal OWL ontology + SHACL shapes. https://github.com/OP-TED/model2owl, 2023.

[9] A. Cimmino, E. Ruckhaus, et al. Astrea: Automatic generation of SHACL shapes from ontologies. In *ISWC*, 2020, pp. 497–513.

[10] N. Matentzoglu et al. SSSOM: A simple standard for sharing ontology mappings. *Database*, 2022, baac035.

[11] W3C OWL Working Group. OWL 2 Web Ontology Language Document Overview. W3C Recommendation, 2012. https://www.w3.org/TR/owl2-overview/

[12] H. Knublauch, D. Kontokostas. Shapes Constraint Language (SHACL). W3C Recommendation, 2017. https://www.w3.org/TR/shacl/

[13] A. Minello et al. Using SHACL to validate clinical data expressed as RDF. In *MedInfo*, 2023.

[14] E. Prud'hommeaux, J. E. Labra Gayo, H. Solbrig. Shape Expressions: an RDF validation and transformation language. In *LDOW*, 2014.

[15] M. A. Musen. The Protégé project: A look back and a look forward. *AI Matters*, 1(4):4–12, 2015.

[16] E. Barzdins et al. OWLGrEd: A UML-style graphical notation and editor for OWL 2. In *OWL: Experiences and Directions*, 2010.

[17] HL7 International. FHIR: Fast Healthcare Interoperability Resources. https://hl7.org/fhir/, Release 4, 2019.

[18] G. Hripcsak et al. Observational Health Data Sciences and Informatics (OHDSI): Opportunities for Observational Researchers. In *MedInfo*, 2015, pp. 574–578.

[19] K. M. Garza et al. Evaluating common data models for use with a longitudinal community registry. *Journal of Biomedical Informatics*, 2016.

[20] R. Freimuth et al. A FHIR-based approach to semantic interoperability in clinical research. *AMIA Annual Symposium*, 2018.

[21] AIDAVA Project. AIDAVA Reference Ontology (aidava-sphn.ttl). https://github.com/AIDAVA-DEV/AIDAVA-Reference-Ontology, 2024.

[22] H. Bast, J. Buchhold, E. Haußmann. QLever: A query engine for efficient SPARQL+Text search. In *CIKM*, 2017.
