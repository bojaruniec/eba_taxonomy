# Stage 1: Build
FROM maven:3.9.6-eclipse-temurin-17 AS builder
WORKDIR /app
COPY pom.xml .
# Cache dependencies
RUN mvn dependency:go-offline
# Build
COPY src ./src
RUN mvn clean package -DskipTests

# Stage 2: Runtime
FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*-jar-with-dependencies.jar migrator.jar

# Run the app
CMD ["java", "-jar", "migrator.jar"]
