// VANTA Minecraft bridge plugin.
//
// Targets PaperMC 1.21.x. Built inside Dockerfile.paper via the
// official `gradle:8.10.2-jdk21` image — no host Java/Gradle install
// needed for the docker-compose path. SDKMAN-driven host builds work
// too (Java + Gradle pinned in versions.json + .tool-versions).

plugins {
    kotlin("jvm") version "2.0.21"
    id("com.gradleup.shadow") version "8.3.5"
}

group = "co.vanta"
version = "0.1.0"

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT")
}

kotlin {
    jvmToolchain(21)
}

tasks {
    // Single-shot fat jar so the runtime image only needs to drop one
    // file into Paper's plugins/ directory — no per-deploy classpath
    // wrangling.
    shadowJar {
        archiveClassifier.set("")
    }
    build {
        dependsOn(shadowJar)
    }
}
