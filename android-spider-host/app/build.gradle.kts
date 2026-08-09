import org.gradle.api.tasks.testing.Test

plugins {
    id("com.android.application")
}

android {
    namespace = "com.qx.yingshi.androidhost"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.qx.yingshi.androidhost"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")
    testImplementation("junit:junit:4.13.2")
}

// AGP's generated test task loses the test output directory on this workspace's
// non-ASCII Windows path. Keep a small explicit JVM unit-test task so the
// Host's deterministic resolver tests still run against the compiled classes.
val hostTestClasses = layout.buildDirectory.dir("intermediates/javac/debugUnitTest/compileDebugUnitTestJavaWithJavac/classes")
val hostMainClasses = layout.buildDirectory.dir("intermediates/javac/debug/compileDebugJavaWithJavac/classes")
val hostTestStage = file(System.getProperty("java.io.tmpdir")).resolve("qx-android-host-unit-test")
val stageHostUnitTest = tasks.register<Sync>("stageHostUnitTest") {
    dependsOn("compileDebugUnitTestJavaWithJavac")
    from(hostTestClasses) { into("test") }
    from(hostMainClasses) { into("main") }
    into(hostTestStage)
}

tasks.register<Test>("hostUnitTest") {
    dependsOn(stageHostUnitTest)
    testClassesDirs = files(hostTestStage.resolve("test"))
    classpath = files(
        hostTestStage.resolve("test"),
        hostTestStage.resolve("main"),
        configurations.getByName("debugUnitTestRuntimeClasspath").filter { file ->
            file.name.startsWith("junit-") || file.name.startsWith("hamcrest-")
        },
    )
}
