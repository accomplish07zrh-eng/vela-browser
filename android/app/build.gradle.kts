plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The version follows the desktop app (package.json); CI passes it, a local build reads it.
val velaVersion: String = (System.getenv("VELA_VERSION")
    ?: Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(rootProject.file("../package.json").readText())?.groupValues?.get(1)
    ?: "0.0.0")
val velaCode: Int = velaVersion.split(".").map { it.toIntOrNull() ?: 0 }.let { (it.getOrElse(0) { 0 } * 10000) + (it.getOrElse(1) { 0 } * 100) + it.getOrElse(2) { 0 } }

android {
    namespace = "app.vela.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.vela.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = velaCode
        versionName = velaVersion
    }

    // Release signing comes from the environment (CI); without it a release build is signed with the debug key for trying out.
    val keystorePath = System.getenv("VELA_KEYSTORE")
    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("VELA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("VELA_KEY_ALIAS")
                keyPassword = System.getenv("VELA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.11.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Liquid glass: blur of what is behind the controls
    implementation("dev.chrisbanes.haze:haze:1.0.2")
    // Scanning the pairing code: CameraX for the picture, ZXing to read it
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("junit:junit:4.13.2")
}
