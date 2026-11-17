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
