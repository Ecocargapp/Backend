# Graph Report - .  (2026-08-05)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 111 nodes · 173 edges · 15 communities (8 shown, 7 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.62)
- Token cost: 629 input · 159 output

## Graph Freshness
- Built from commit: `0a93d48b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AgroSoft Pig Farm Backend
- Breeding & Sow Database Schema
- Node.js Package Dependencies
- DB Pool & Costing Routes
- Express Routing & Auth Middleware
- Package Configuration
- Fattening & Band Database Schema
- Fattening Cost Calculation
- DB Initialization Scripts
- Inventory Schema
- Task Catalog Init
- Breeding Routes Logic
- Fattening DB Init
- Costing DB Init
- Task Routes Logic

## God Nodes (most connected - your core abstractions)
1. `usuarios` - 15 edges
2. `pool` - 14 edges
3. `AgroSoft Backend` - 10 edges
4. `cerdas` - 8 edges
5. `granjas_ceba` - 5 edges
6. `lotes_destete` - 5 edges
7. `servicios` - 5 edges
8. `partos` - 5 edges
9. `Granja de Cría Module (Reproductive Cycle)` - 5 edges
10. `calcularCosteoBanda()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `consumo_ceba` --references--> `usuarios`  [EXTRACTED]
  schema_ceba.sql → schema.sql
- `liquidaciones_ceba` --references--> `usuarios`  [EXTRACTED]
  schema_ceba.sql → schema.sql
- `lotes_destete` --references--> `usuarios`  [EXTRACTED]
  schema_ceba.sql → schema.sql
- `movimientos_ceba` --references--> `usuarios`  [EXTRACTED]
  schema_ceba.sql → schema.sql
- `consumo_diario` --references--> `usuarios`  [EXTRACTED]
  schema_costeo.sql → schema.sql

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Reproductive Cycle Event Flow (Servicio → Gestante → Parto → Lactante → Destete → Vacía)** — readme_cria_module, readme_costeo_module, readme_tareas_module, readme_informes_module [EXTRACTED 0.92]

## Communities (15 total, 7 thin omitted)

### Community 0 - "AgroSoft Pig Farm Backend"
Cohesion: 0.17
Nodes (16): AgroSoft Backend, Authentication Module (JWT + bcrypt), bcrypt Password Hashing, Ceba / Engorde Module (Fattening), Costeo por Banda Module (Band Costing), Granja de Cría Module (Reproductive Cycle), EC2 Deployment, Informes de Cría Module (Reports) (+8 more)

### Community 1 - "Breeding & Sow Database Schema"
Cohesion: 0.29
Nodes (12): consumo_diario, lactancia_banda, cerdas, destetes, diagnosticos, partos, razas, salidas_cerda (+4 more)

### Community 2 - "Node.js Package Dependencies"
Cohesion: 0.15
Nodes (13): bcryptjs, cors, dotenv, express, jsonwebtoken, dependencies, bcryptjs, cors (+5 more)

### Community 4 - "Express Routing & Auth Middleware"
Cohesion: 0.25
Nodes (4): router, router, app, origenesPermitidos

### Community 5 - "Package Configuration"
Cohesion: 0.22
Nodes (8): description, main, name, scripts, init-db, start, type, version

### Community 6 - "Fattening & Band Database Schema"
Cohesion: 0.39
Nodes (7): consumo_ceba, granjas_ceba, liquidaciones_ceba, lotes_destete, movimientos_ceba, bandas, consumos_alimento

### Community 7 - "Fattening Cost Calculation"
Cohesion: 0.50
Nodes (3): calcularCosteoBanda(), calcularValoresLote(), router

### Community 9 - "Inventory Schema"
Cohesion: 0.80
Nodes (4): inventario, items, movimientos, ubicaciones

## Knowledge Gaps
- **27 isolated node(s):** `__dirname`, `__dirname`, `__dirname`, `__dirname`, `__dirname` (+22 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pool` connect `DB Pool & Costing Routes` to `Express Routing & Auth Middleware`, `Fattening Cost Calculation`, `DB Initialization Scripts`, `Task Catalog Init`, `Breeding Routes Logic`, `Fattening DB Init`, `Costing DB Init`, `Task Routes Logic`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Why does `usuarios` connect `Breeding & Sow Database Schema` to `Inventory Schema`, `Fattening & Band Database Schema`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Node.js Package Dependencies` to `Package Configuration`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **What connects `__dirname`, `__dirname`, `__dirname` to the rest of the system?**
  _27 weakly-connected nodes found - possible documentation gaps or missing edges._