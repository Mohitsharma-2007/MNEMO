package com.attendx.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.attendx.app.api.Api
import com.attendx.app.api.Session
import org.json.JSONArray

@Composable
fun DashboardScreen(api: Api, session: Session, onMustChangePassword: () -> Unit, modifier: Modifier = Modifier) {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var summary by remember { mutableStateOf<JSONArray>(JSONArray()) }
    var classes by remember { mutableStateOf<JSONArray>(JSONArray()) }

    LaunchedEffect(session.role) {
        loading = true; error = null
        try {
            when (session.role) {
                "student" -> summary = api.studentSummary()
                "faculty" -> classes = api.classes(session.userId)
                else -> summary = api.studentSummary()
            }
        } catch (e: Exception) {
            error = e.message
        }
        loading = false
    }

    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Text("Hello, ${session.fullName}", style = MaterialTheme.typography.headlineSmall)
        Text(
            "${session.role.replaceFirstChar { it.uppercase() }} workspace · ${session.identifier.ifBlank { session.email }}",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(16.dp))

        when {
            loading -> CircularProgressIndicator(Modifier.padding(24.dp))
            error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
            session.role == "student" -> StudentSummary(summary)
            session.role == "faculty" -> FacultyClasses(classes)
            else -> AdminSummary(summary)
        }
    }
}

@Composable
private fun StudentSummary(rows: JSONArray) {
    if (rows.length() == 0) {
        Text("No attendance records yet — join a batch and mark your first session.", style = MaterialTheme.typography.bodyMedium)
        return
    }
    var present = 0; var total = 0
    for (i in 0 until rows.length()) {
        val r = rows.getJSONObject(i)
        present += r.optInt("sessions_present")
        total += r.optInt("completed_sessions")
    }
    val pct = if (total == 0) 0 else present * 100 / total
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        MetricCard("Attendance", "$pct%", Modifier.weight(1f))
        MetricCard("Present", "$present/$total", Modifier.weight(1f))
    }
    Spacer(Modifier.height(16.dp))
    Text("My classes", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(8.dp))
    for (i in 0 until rows.length()) {
        val r = rows.getJSONObject(i)
        val clsPct = r.optInt("attendance_percentage")
        Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Column(Modifier.padding(14.dp)) {
                Text(r.optString("class_name"), fontWeight = FontWeight.SemiBold)
                Text("${r.optString("class_code")} · ${r.optInt("sessions_present")}/${r.optInt("completed_sessions")} sessions · $clsPct%", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun FacultyClasses(rows: JSONArray) {
    Text("Your classes", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(8.dp))
    if (rows.length() == 0) {
        Text("No classes assigned yet. An administrator assigns classes from the web dashboard.", style = MaterialTheme.typography.bodyMedium)
        return
    }
    for (i in 0 until rows.length()) {
        val c = rows.getJSONObject(i)
        Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Column(Modifier.padding(14.dp)) {
                Text(c.optString("name"), fontWeight = FontWeight.SemiBold)
                Text("${c.optString("code")} · ${c.optString("department")}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun AdminSummary(rows: JSONArray) {
    Text("Institutional overview", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(8.dp))
    Text(
        "Use People, Mail Center and the web dashboard to manage accounts, send institutional mail and review attendance.",
        style = MaterialTheme.typography.bodyMedium,
    )
    if (rows.length() > 0) {
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MetricCard("Sessions", "${rows.length()}", Modifier.weight(1f))
        }
    }
}

@Composable
private fun MetricCard(title: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.width(18.dp).height(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(title, style = MaterialTheme.typography.labelMedium)
            }
            Spacer(Modifier.height(6.dp))
            Text(value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        }
    }
}