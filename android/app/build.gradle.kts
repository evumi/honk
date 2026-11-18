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

val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
fun env(name: String): String? = System.getenv(name)?.takeIf { it.isNotBlank() }

// The gateway URL: -Phonk.gatewayUrl=…, HONK_GATEWAY_URL, or honk.gatewayUrl in
// android/local.properties. The default reaches a gateway on the development
// machine from the emulator.
val gatewayUrl = (findProperty("honk.gatewayUrl") as String?)
    ?: env("HONK_GATEWAY_URL")
    ?: localProps.getProperty("honk.gatewayUrl")
    ?: "http://10.0.2.2:8080/"

// Release signing from HONK_KEYSTORE_FILE (absolute path), HONK_KEYSTORE_PASSWORD,
// HONK_KEY_ALIAS and HONK_KEY_PASSWORD; without them a release build is signed
// with the debug key, so assembleRelease also works locally.
val releaseKeystore = env("HONK_KEYSTORE_FILE")?.let(::file)

val hasAndroidSdk = env("ANDROID_HOME") != null || env("ANDROID_SDK_ROOT") != null || localProps.getProperty("sdk.dir") != null

android {
    namespace = "dev.evumi.honk"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.evumi.honk"
        minSdk = 26
        targetSdk = 35
        // CI sets HONK_VERSION_CODE / HONK_VERSION_NAME.
        versionCode = env("HONK_VERSION_CODE")?.toInt() ?: 1
        versionName = env("HONK_VERSION_NAME") ?: "0.1.0"
        buildConfigField("String", "GATEWAY_URL", "\"$gatewayUrl\"")
        buildConfigField("boolean", "HAS_FIREBASE", hasFirebase.toString())
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = env("HONK_KEYSTORE_PASSWORD")
                keyAlias = env("HONK_KEY_ALIAS")
                keyPassword = env("HONK_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // A local gateway is plain http.
            manifestPlaceholders["cleartext"] = "true"
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            // Plain http only when the gateway URL is http (a local test build).
            manifestPlaceholders["cleartext"] = gatewayUrl.startsWith("http://").toString()
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

    // libhonkcard.so: card scripts (quickjs-ng and the card sandbox, native/), for CardHost in :core.
    // Only with an SDK: CMake makes AGP look for one while configuring, and
    // `./gradlew :core:test` must keep working with only a JDK.
    if (hasAndroidSdk) {
        externalNativeBuild {
            cmake {
                path = rootProject.file("../native/jni/CMakeLists.txt")
                version = "3.22.1"
            }
        }
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
