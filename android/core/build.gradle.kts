plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.serialization.json)
    testImplementation(libs.junit)
    // The tests run LocalStore on SQLite through JDBC; the app uses android.database.sqlite.
    testImplementation(libs.sqlite.jdbc)
}

// CardHostTest loads libhonkcard built for this machine from native/ (the app
// builds it for Android with CMake). Needs make and a C compiler.
val nativeDir = rootDir.resolve("../native")
val buildCardLib by tasks.registering(Exec::class) {
    val jdk = javaToolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(17)) }
    doFirst { environment("JAVA_HOME", jdk.get().metadata.installationPath.asFile.absolutePath) }
    commandLine("make", "-C", nativeDir.absolutePath, "jni")
}
tasks.test {
    dependsOn(buildCardLib)
    systemProperty("java.library.path", nativeDir.resolve("build").absolutePath)
    // HostContractTest reads the host contract shared with the nsh app and HonkKit.
    systemProperty("honk.contract", rootDir.resolve("../app/src/host.contract.json").absolutePath)
}
