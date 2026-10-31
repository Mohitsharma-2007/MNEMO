package com.attendx.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import org.json.JSONArray

@Composable
fun PeopleScreen(api: Api, modifier: Modifier = Modifier) {
    var users by remember { mutableStateOf<JSONArray>(JSONArray()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        loading = true; error = null
        try {
            users = api.directory()
        } catch (e: Exception) {
            error = e.message
        }
        loading = false
    }

    Column(modifier = modifier.padding(16.dp)) {
        Text("People", style = MaterialTheme.typography.headlineSmall)
        Text("All institution accounts with academic details.", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(12.dp))

        when {
            loading -> CircularProgressIndicator(Modifier.padding(20.dp))
            error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
            users.length() == 0 -> Text("No accounts yet.", style = MaterialTheme.typography.bodyMedium)
            else -> LazyColumn {
                items(count = users.length()) { idx ->
                    val u = users.getJSONObject(idx)
                    Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Column(Modifier.padding(12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(u.optString("full_name"), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                Text(u.optString("role"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                            Text(u.optString("email"), style = MaterialTheme.typography.bodySmall)
                            Text(
                                buildList {
                                    u.optString("identifier").takeIf { it.isNotBlank() }?.let { add(it) }
                                    u.optString("department").takeIf { it.isNotBlank() }?.let { add(it) }
                                    u.optString("academic_year").takeIf { it.isNotBlank() }?.let { add(it) }
                                }.joinToString(" · ").ifEmpty { "—" },
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
            }
        }
    }
}