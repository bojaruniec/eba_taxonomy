# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 – Build: compile and package the fat JAR with Maven
# ─────────────────────────────────────────────────────────────────────────────
FROM maven:3.9.8-eclipse-temurin-17 AS builder

WORKDIR /build

# Copy the POM first to leverage Docker layer caching for dependency downloads
COPY pom.xml .
RUN mvn dependency:go-offline -B --no-transfer-progress

# Copy source and build the fat JAR (skip tests – no DB available at build time)
COPY src ./src
RUN mvn package -B --no-transfer-progress -DskipTests

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 – Run: lightweight JRE-only image
# ─────────────────────────────────────────────────────────────────────────────
FROM eclipse-temurin:17-jre-alpine

LABEL maintainer="EBA Taxonomy Team"
LABEL description="Phase 1: Export MS Access tables to CSV (max 20 rows each)"

WORKDIR /app

# Copy the fat JAR from the build stage
COPY --from=builder /build/target/eba-taxonomy-migrator-1.0.0.jar app.jar

# Expected volume mount points (documented for clarity)
# /app/inp  -> host ./inp  (contains the .accdb file)
# /app/out  -> host ./out  (CSV files will be written to /app/out/csv/)

# Environment variables with defaults matching the project rules
ENV DB_PATH=/app/inp/database.accdb
ENV OUT_DIR=/app/out/csv

ENTRYPOINT ["java", "-jar", "app.jar"]
