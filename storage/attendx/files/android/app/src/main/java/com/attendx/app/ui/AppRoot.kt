package com.attendx.app.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.attendx.app.api.Api
import com.attendx.app.api.Session
import com.attendx.app.api.SessionStore
import com.attendx.app.ui.theme.AttendXTheme

fun isDeveloperModeEnabled(context: Context): Boolean =
    Settings.Global.getInt(context.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1

sealed class Screen {
    object Splash : Screen()
    object Login : Screen()
    object Workspace : Screen()
    object PendingApproval : Screen()
    object MustChangePassword : Screen()
    object DevModeBlocked : Screen()
}

@Composable
fun AppRoot() {
    val context = LocalContext.current
    val api = remember { Api(context) }
    val sessionStore = remember { SessionStore(context) }

    var screen by remember { mutableStateOf<Screen>(Screen.Splash) }
    var devBlocked by remember { mutableStateOf(false) }
    var session by remember { mutableStateOf<Session?>(null) }

    LaunchedEffect(Unit) {
        devBlocked = isDeveloperModeEnabled(context)
        session = sessionStore.load()
        screen = if (devBlocked) Screen.DevModeBlocked else when {
            session == null -> Screen.Login
            session!!.approvalStatus == "pending" -> Screen.PendingApproval
            session!!.approvalStatus == "approved_waiting_code" -> Screen.PendingApproval
            else -> Screen.Workspace
        }
    }

    AttendXTheme {
        Scaffold(modifier = Modifier.fillMaxSize()) { inner ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .safeDrawingPadding()
                    .padding(inner),
            ) {
                when (val s = screen) {
                    Screen.Splash -> SplashScreen()
                    Screen.DevModeBlocked -> DevModeBlockedScreen(onRecheck = {
                        devBlocked = isDeveloperModeEnabled(context)
                        if (!devBlocked) screen = if (session == null) Screen.Login else Screen.Workspace
                    })
                    Screen.Login -> LoginScreen(
                        api = api,
                        onSignedIn = { token, profile ->
                            sessionStore.save(token, profile, null)
                            session = sessionStore.load()
                            screen = when (session?.approvalStatus) {
                                "pending" -> Screen.PendingApproval
                                "approved_waiting_code" -> Screen.PendingApproval
                                else -> Screen.Workspace
                            }
                        },
                    )
                    Screen.PendingApproval -> PendingApprovalScreen(onSignOut = {
                        sessionStore.clear(); session = null; screen = Screen.Login
                    })
                    Screen.MustChangePassword -> ChangePasswordScreen(
                        api = api,
                        onDone = { screen = Screen.Workspace },
                        onSignOut = { sessionStore.clear(); session = null; screen = Screen.Login },
                    )
                    Screen.Workspace -> {
                        val active = session ?: return@Column
                        Workspace(
                            api = api,
                            session = active,
                            onSignOut = {
                                sessionStore.clear(); session = null; screen = Screen.Login
                            },
                            onMustChangePassword = { screen = Screen.MustChangePassword },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SplashScreen() {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("AttendX", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
        Text("VERIFIED PRESENCE", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
fun DevModeBlockedScreen(onRecheck: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Filled.Shield, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 16.dp))
        Text("Developer Options Detected", style = MaterialTheme.typography.titleLarge)
        Text(
            "AttendX attendance integrity policy blocks access while Android Developer Options or USB Debugging is active on this device. Turn them off and re-check.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(vertical = 16.dp),
        )
        Button(onClick = onRecheck) { Text("Re-check Status") }
    }
}

@Composable
fun PendingApprovalScreen(onSignOut: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Application under review", style = MaterialTheme.typography.titleLarge)
        Text(
            "Your application is being reviewed by the administration. You will receive an email with an invitation code once approved.",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(vertical = 16.dp),
        )
        Button(onClick = onSignOut) { Text("Sign out") }
    }
}