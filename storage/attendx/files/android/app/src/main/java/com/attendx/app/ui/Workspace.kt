package com.attendx.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.attendx.app.api.Api
import com.attendx.app.api.Session

private data class Tab(val key: String, val label: String, val icon: ImageVector)

@Composable
fun Workspace(
    api: Api,
    session: Session,
    onSignOut: () -> Unit,
    onMustChangePassword: () -> Unit,
) {
    val tabs = remember(session.role) {
        when (session.role) {
            "student" -> listOf(
                Tab("home", "Home", Icons.Filled.Home),
                Tab("mark", "Mark", Icons.Filled.QrCodeScanner),
                Tab("mail", "Mail", Icons.Filled.Email),
                Tab("profile", "Profile", Icons.Filled.Person),
            )
            "faculty" -> listOf(
                Tab("home", "Home", Icons.Filled.Home),
                Tab("session", "Session", Icons.Filled.PlayArrow),
                Tab("mail", "Mail", Icons.Filled.Email),
                Tab("profile", "Profile", Icons.Filled.Person),
            )
            else -> listOf(
                Tab("home", "Home", Icons.Filled.Home),
                Tab("people", "People", Icons.Filled.Group),
                Tab("mail", "Mail", Icons.Filled.Email),
                Tab("profile", "Profile", Icons.Filled.Person),
            )
        }
    }
    var tab by remember { mutableStateOf("home") }

    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t.key,
                        onClick = { tab = t.key },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { inner ->
        when (tab) {
            "mark" -> MarkScreen(api, session, Modifier.padding(inner))
            "session" -> SessionScreen(api, session, Modifier.padding(inner))
            "people" -> PeopleScreen(api, Modifier.padding(inner))
            "mail" -> MailCenterScreen(api, session, Modifier.padding(inner))
            "profile" -> ProfileScreen(api, session, onSignOut, onMustChangePassword, Modifier.padding(inner))
            else -> DashboardScreen(api, session, onMustChangePassword, Modifier.padding(inner))
        }
    }
}