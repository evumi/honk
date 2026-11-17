import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Firebase reads its project from google-services.json (not committed). Without
// it the app builds and runs, but gets no FCM token.
val hasFirebase = file("google-services.json").exists()
if (hasFirebase) {
    apply(plugin = libs.plugins.google.services.get().pluginId)
}

// The gateway URL: -Phonk.gatewayUrl=… or honk.gatewayUrl in android/local.properties.
// The default reaches a gateway on the development machine from the emulator.
val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
val gatewayUrl = (findProperty("honk.gatewayUrl") as String?)
    ?: localProps.getProperty("honk.gatewayUrl")
    ?: "http://10.0.2.2:8080/"

android {
    namespace = "dev.evumi.honk"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.evumi.honk"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "GATEWAY_URL", "\"$gatewayUrl\"")
        buildConfigField("boolean", "HAS_FIREBASE", hasFirebase.toString())
    }

    buildTypes {
        debug {
            // A local gateway is plain http.
            manifestPlaceholders["cleartext"] = "true"
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            manifestPlaceholders["cleartext"] = "false"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // The nsh app built by scripts/build-nsh-bundle.sh: app/dist/nsh → assets/nsh.
    sourceSets["main"].assets.srcDir(rootProject.file("../app/dist"))
}

val nshBundle by tasks.registering(Exec::class) {
    description = "Builds the nsh app (../app) into app/dist/nsh"
    commandLine(rootProject.file("../scripts/build-nsh-bundle.sh").path)
}
tasks.named("preBuild") { dependsOn(nshBundle) }

if (!file("libs/nsh.aar").exists() || !file("libs/nsh-dev.aar").exists()) {
    logger.warn("android/app/libs has no nsh AARs: run scripts/fetch-nsh-android.sh")
}

dependencies {
    implementation(project(":core"))
    // nsh-dev.aar can also connect to `nsh dev` for hot reload.
    debugImplementation(files("libs/nsh-dev.aar"))
    releaseImplementation(files("libs/nsh.aar"))

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.androidx.core)
    implementation(libs.androidx.activity)
    implementation(libs.lifecycle.runtime)
    implementation(libs.security.crypto)
    implementation(libs.coroutines.android)
}
