pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "honk-android"

// :core is plain Kotlin/JVM (gateway client, local store, sync): `./gradlew :core:test`
// needs only a JDK. :app needs the Android SDK.
include(":core", ":app")
