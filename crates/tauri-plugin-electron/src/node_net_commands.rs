//! The commands behind Node's `net`, `dgram`, `dns` and `tls` (Cargo
//! features `node-net`, `node-tls`). Each refuses callers other than the
//! main window showing the app's own page. Without `node-net`, the same
//! commands exist and report the feature as disabled.

use serde_json::Value;
use tauri::{ipc::Channel, Runtime, Webview};

#[cfg(feature = "node-net")]
mod enabled {
    use std::sync::Arc;

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use serde_json::{json, Value};
    use tauri::{ipc::Channel, Manager, Runtime, Webview};

    use crate::{node_dns, node_net::Net};

    fn allowed<R: Runtime>(webview: &Webview<R>) -> Result<Arc<Net>, Value> {
        if let Some(refusal) = crate::node_refusal(webview.app_handle(), webview.label()) {
            return Err(refusal);
        }
        Ok(webview.state::<Arc<Net>>().inner().clone())
    }

    fn bytes(data: &str) -> Result<Vec<u8>, Value> {
        BASE64
            .decode(data.as_bytes())
            .map_err(|e| json!({ "code": "ERR_INVALID_ARG_VALUE", "message": e.to_string() }))
    }

    fn options<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Value> {
        serde_json::from_value(value)
            .map_err(|e| json!({ "code": "ERR_INVALID_ARG_VALUE", "message": e.to_string() }))
    }

    #[tauri::command]
    pub async fn net_connect<R: Runtime>(
        webview: Webview<R>,
        options: Value,
        on_event: Channel<Value>,
    ) -> Result<Value, Value> {
        let net = allowed(&webview)?;
        net.connect(self::options(options)?, on_event).await
    }

    #[tauri::command]
    pub async fn net_listen<R: Runtime>(
        webview: Webview<R>,
        options: Value,
        on_event: Channel<Value>,
    ) -> Result<Value, Value> {
        let net = allowed(&webview)?;
        net.listen(self::options(options)?, on_event).await
    }

    #[tauri::command]
    pub async fn net_write<R: Runtime>(
        webview: Webview<R>,
        id: u32,
        data: String,
    ) -> Result<(), Value> {
        let net = allowed(&webview)?;
        net.write(id, bytes(&data)?).await
    }

    #[tauri::command]
    pub async fn net_end<R: Runtime>(webview: Webview<R>, id: u32) -> Result<(), Value> {
        let net = allowed(&webview)?;
        net.end(id).await
    }

    #[tauri::command]
    pub fn net_destroy<R: Runtime>(webview: Webview<R>, id: u32) -> Result<(), Value> {
        allowed(&webview)?.destroy(id);
        Ok(())
    }

    #[tauri::command]
    pub fn net_pause<R: Runtime>(webview: Webview<R>, id: u32, paused: bool) -> Result<(), Value> {
        allowed(&webview)?.set_paused(id, paused)
    }

    #[tauri::command]
    pub fn net_set_option<R: Runtime>(
        webview: Webview<R>,
        id: u32,
        name: String,
        value: Value,
    ) -> Result<(), Value> {
        allowed(&webview)?.set_option(id, &name, &value)
    }

    #[tauri::command]
    pub async fn udp_bind<R: Runtime>(
        webview: Webview<R>,
        options: Value,
        on_event: Channel<Value>,
    ) -> Result<Value, Value> {
        let net = allowed(&webview)?;
        net.udp_bind(self::options(options)?, on_event).await
    }

    #[tauri::command]
    pub async fn udp_send<R: Runtime>(
        webview: Webview<R>,
        id: u32,
        data: String,
        port: u16,
        address: String,
    ) -> Result<usize, Value> {
        let net = allowed(&webview)?;
        net.udp_send(id, bytes(&data)?, port, address).await
    }

    #[tauri::command]
    pub fn udp_option<R: Runtime>(
        webview: Webview<R>,
        id: u32,
        name: String,
        value: Value,
    ) -> Result<Value, Value> {
        allowed(&webview)?.udp_option(id, &name, &value)
    }

    #[tauri::command]
    pub fn udp_membership<R: Runtime>(
        webview: Webview<R>,
        id: u32,
        add: bool,
        group: String,
        interface: Option<String>,
    ) -> Result<(), Value> {
        allowed(&webview)?.udp_membership(id, add, &group, interface.as_deref())
    }

    #[tauri::command]
    pub async fn dns_lookup<R: Runtime>(
        webview: Webview<R>,
        hostname: String,
        family: u8,
    ) -> Result<Value, Value> {
        allowed(&webview)?;
        node_dns::lookup(&hostname, family).await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn dns_resolve<R: Runtime>(
        webview: Webview<R>,
        hostname: String,
        rrtype: String,
        ttl: bool,
        servers: Vec<String>,
        timeout: Option<u64>,
        tries: Option<usize>,
    ) -> Result<Value, Value> {
        allowed(&webview)?;
        node_dns::resolve(&hostname, &rrtype, ttl, &servers, timeout, tries).await
    }

    #[tauri::command]
    pub async fn dns_reverse<R: Runtime>(
        webview: Webview<R>,
        ip: String,
        servers: Vec<String>,
        timeout: Option<u64>,
        tries: Option<usize>,
    ) -> Result<Value, Value> {
        allowed(&webview)?;
        node_dns::reverse(&ip, &servers, timeout, tries).await
    }

    #[tauri::command]
    pub fn dns_servers<R: Runtime>(webview: Webview<R>) -> Result<Value, Value> {
        allowed(&webview)?;
        Ok(node_dns::system_servers())
    }
}

#[cfg(feature = "node-net")]
pub use enabled::*;

#[cfg(not(feature = "node-net"))]
mod disabled {
    use serde_json::{json, Value};
    use tauri::{Runtime, Webview};

    fn off() -> Result<Value, Value> {
        Err(json!({ "code": "ERR_FEATURE_DISABLED", "feature": "node-net" }))
    }

    macro_rules! disabled {
        ($($name:ident),*) => {$(
            #[tauri::command]
            pub fn $name<R: Runtime>(_webview: Webview<R>) -> Result<Value, Value> {
                off()
            }
        )*};
    }

    disabled!(
        net_connect,
        net_listen,
        net_write,
        net_end,
        net_destroy,
        net_pause,
        net_set_option,
        udp_bind,
        udp_send,
        udp_option,
        udp_membership,
        dns_lookup,
        dns_resolve,
        dns_reverse,
        dns_servers
    );
}

#[cfg(not(feature = "node-net"))]
pub use disabled::*;

// Keep the imports used in both configurations.
#[allow(dead_code)]
fn _types<R: Runtime>(_: Option<Webview<R>>, _: Option<Channel<Value>>) {}
