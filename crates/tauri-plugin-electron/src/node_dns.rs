//! Node's `dns` (Cargo feature `node-net`).
//!
//! - `lookup()` uses the operating system's resolver (getaddrinfo), like Node:
//!   it honours /etc/hosts and the system's search domains.
//! - `resolve*()` and `reverse()` query DNS servers directly (hickory), with
//!   the system configuration or the servers given to `dns.setServers()`.
//!
//! Errors are JSON shaped like Node's: `{ code, syscall, hostname }`.

use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};

use hickory_resolver::{
    config::{NameServerConfig, ResolverConfig},
    net::{runtime::TokioRuntimeProvider, NetError},
    proto::{
        op::ResponseCode,
        rr::{Name, RData, RecordType},
    },
    Resolver, TokioResolver,
};
use serde_json::{json, Value};

fn error(code: &str, syscall: &str, hostname: &str) -> Value {
    json!({ "code": code, "syscall": syscall, "hostname": hostname })
}

/// `dns.lookup(hostname, { family, all })`: `[{ address, family }]`.
pub async fn lookup(hostname: &str, family: u8) -> Result<Value, Value> {
    let addresses: Vec<IpAddr> = if let Ok(ip) = hostname.parse::<IpAddr>() {
        vec![ip]
    } else {
        match tokio::net::lookup_host((hostname, 0)).await {
            Ok(found) => found.map(|a: SocketAddr| a.ip()).collect(),
            Err(e) => {
                let text = e.to_string().to_lowercase();
                let code = if text.contains("temporary") || text.contains("try again") {
                    "EAI_AGAIN"
                } else {
                    "ENOTFOUND"
                };
                return Err(error(code, "getaddrinfo", hostname));
            }
        }
    };
    let mut seen = Vec::new();
    let list: Vec<Value> = addresses
        .into_iter()
        .filter(|ip| match family {
            4 => ip.is_ipv4(),
            6 => ip.is_ipv6(),
            _ => true,
        })
        .filter(|ip| {
            let fresh = !seen.contains(ip);
            seen.push(*ip);
            fresh
        })
        .map(|ip| json!({ "address": ip.to_string(), "family": if ip.is_ipv4() { 4 } else { 6 } }))
        .collect();
    if list.is_empty() {
        return Err(error("ENOTFOUND", "getaddrinfo", hostname));
    }
    Ok(Value::Array(list))
}

static SYSTEM: OnceLock<Arc<TokioResolver>> = OnceLock::new();

/// The resolver for `servers` (`"1.1.1.1"`, `"[::1]:5353"`), or the system's.
fn resolver(
    servers: &[String],
    timeout_ms: Option<u64>,
    tries: Option<usize>,
) -> Result<Arc<TokioResolver>, Value> {
    let custom = !servers.is_empty() || timeout_ms.is_some() || tries.is_some();
    if !custom {
        if let Some(resolver) = SYSTEM.get() {
            return Ok(resolver.clone());
        }
    }
    let mut builder = if servers.is_empty() {
        Resolver::builder_tokio().map_err(|_| error("ECONNREFUSED", "queryA", ""))?
    } else {
        let mut configs = Vec::new();
        for server in servers {
            let (ip, port) =
                parse_server(server).ok_or_else(|| error("EINVAL", "setServers", server))?;
            let mut config = NameServerConfig::udp_and_tcp(ip);
            for connection in &mut config.connections {
                connection.port = port;
            }
            configs.push(config);
        }
        Resolver::builder_with_config(
            ResolverConfig::from_name_servers(configs),
            TokioRuntimeProvider::default(),
        )
    };
    if let Some(ms) = timeout_ms {
        builder.options_mut().timeout = Duration::from_millis(ms.max(1));
    }
    if let Some(tries) = tries {
        builder.options_mut().attempts = tries.max(1);
    }
    let resolver = Arc::new(
        builder
            .build()
            .map_err(|_| error("ECONNREFUSED", "queryA", ""))?,
    );
    if !custom {
        let _ = SYSTEM.set(resolver.clone());
    }
    Ok(resolver)
}

fn parse_server(server: &str) -> Option<(IpAddr, u16)> {
    if let Ok(ip) = server.parse::<IpAddr>() {
        return Some((ip, 53));
    }
    server
        .parse::<SocketAddr>()
        .ok()
        .map(|a| (a.ip(), a.port()))
}

fn name(name: &Name) -> String {
    name.to_utf8().trim_end_matches('.').to_string()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn record_type(rrtype: &str) -> Option<RecordType> {
    Some(match rrtype {
        "A" => RecordType::A,
        "AAAA" => RecordType::AAAA,
        "ANY" => RecordType::ANY,
        "CAA" => RecordType::CAA,
        "CNAME" => RecordType::CNAME,
        "MX" => RecordType::MX,
        "NAPTR" => RecordType::NAPTR,
        "NS" => RecordType::NS,
        "PTR" => RecordType::PTR,
        "SOA" => RecordType::SOA,
        "SRV" => RecordType::SRV,
        "TXT" => RecordType::TXT,
        _ => return None,
    })
}

/// One record in Node's shape for `resolveX()`; `any` adds `type` (for `resolveAny()`).
fn shape(data: &RData, ttl: u32, with_ttl: bool, any: bool) -> Option<Value> {
    let (kind, mut value) = match data {
        RData::A(a) if with_ttl || any => ("A", json!({ "address": a.0.to_string(), "ttl": ttl })),
        RData::A(a) => ("A", json!(a.0.to_string())),
        RData::AAAA(a) if with_ttl || any => {
            ("AAAA", json!({ "address": a.0.to_string(), "ttl": ttl }))
        }
        RData::AAAA(a) => ("AAAA", json!(a.0.to_string())),
        RData::CNAME(n) => (
            "CNAME",
            if any {
                json!({ "value": name(&n.0) })
            } else {
                json!(name(&n.0))
            },
        ),
        RData::NS(n) => (
            "NS",
            if any {
                json!({ "value": name(&n.0) })
            } else {
                json!(name(&n.0))
            },
        ),
        RData::PTR(n) => (
            "PTR",
            if any {
                json!({ "value": name(&n.0) })
            } else {
                json!(name(&n.0))
            },
        ),
        RData::MX(mx) => (
            "MX",
            json!({ "exchange": name(&mx.exchange), "priority": mx.preference }),
        ),
        RData::TXT(txt) => {
            let chunks: Vec<String> = txt.txt_data.iter().map(|c| text(c)).collect();
            (
                "TXT",
                if any {
                    json!({ "entries": chunks })
                } else {
                    json!(chunks)
                },
            )
        }
        RData::SRV(srv) => (
            "SRV",
            json!({ "name": name(&srv.target), "port": srv.port, "priority": srv.priority, "weight": srv.weight }),
        ),
        RData::SOA(soa) => (
            "SOA",
            json!({
                "nsname": name(&soa.mname), "hostmaster": name(&soa.rname), "serial": soa.serial,
                "refresh": soa.refresh, "retry": soa.retry, "expire": soa.expire, "minttl": soa.minimum,
            }),
        ),
        RData::CAA(caa) => {
            let mut entry = json!({ "critical": if caa.issuer_critical { 128 } else { 0 } });
            entry[caa.tag.clone()] = json!(text(&caa.value));
            ("CAA", entry)
        }
        RData::NAPTR(n) => (
            "NAPTR",
            json!({
                "flags": text(&n.flags), "service": text(&n.services), "regexp": text(&n.regexp),
                "replacement": name(&n.replacement), "order": n.order, "preference": n.preference,
            }),
        ),
        _ => return None,
    };
    if any {
        value["type"] = json!(kind);
    }
    Some(value)
}

/// Node's code for a failed query.
fn query_error(e: &NetError) -> &'static str {
    if e.is_nx_domain() {
        return "ENOTFOUND";
    }
    if e.is_no_records_found() {
        return "ENODATA";
    }
    match e {
        NetError::Timeout => "ETIMEOUT",
        NetError::Dns(hickory_resolver::net::DnsError::ResponseCode(code)) => match *code {
            ResponseCode::ServFail => "ESERVFAIL",
            ResponseCode::Refused => "EREFUSED",
            ResponseCode::FormErr => "EFORMERR",
            ResponseCode::NotImp => "ENOTIMP",
            _ => "EBADRESP",
        },
        NetError::NoConnections | NetError::Io(_) => "ECONNREFUSED",
        _ => "EBADRESP",
    }
}

fn syscall(rrtype: &str) -> String {
    let lower = rrtype.to_lowercase();
    let mut chars = lower.chars();
    format!(
        "query{}",
        chars
            .next()
            .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
            .unwrap_or_default()
    )
}

/// `dns.resolve(hostname, rrtype)` and friends; `ttl` for resolve4/6 `{ ttl: true }`.
pub async fn resolve(
    hostname: &str,
    rrtype: &str,
    ttl: bool,
    servers: &[String],
    timeout_ms: Option<u64>,
    tries: Option<usize>,
) -> Result<Value, Value> {
    let call = syscall(rrtype);
    let Some(kind) = record_type(rrtype) else {
        return Err(
            json!({ "code": "ERR_INVALID_ARG_VALUE", "message": format!("The argument 'rrtype' is invalid. Received '{rrtype}'") }),
        );
    };
    let resolver = resolver(servers, timeout_ms, tries)?;
    let lookup = resolver
        .lookup(hostname, kind)
        .await
        .map_err(|e| error(query_error(&e), &call, hostname))?;
    let any = kind == RecordType::ANY;
    let records: Vec<Value> = lookup
        .answers()
        .iter()
        .filter_map(|r| shape(&r.data, r.ttl, ttl, any))
        .collect();
    if kind == RecordType::SOA {
        return records
            .into_iter()
            .next()
            .ok_or_else(|| error("ENODATA", &call, hostname));
    }
    if records.is_empty() {
        return Err(error("ENODATA", &call, hostname));
    }
    Ok(Value::Array(records))
}

/// `dns.reverse(ip)`: the PTR names of an address.
pub async fn reverse(
    ip: &str,
    servers: &[String],
    timeout_ms: Option<u64>,
    tries: Option<usize>,
) -> Result<Value, Value> {
    let address: IpAddr = ip
        .parse()
        .map_err(|_| error("EINVAL", "getHostByAddr", ip))?;
    let resolver = resolver(servers, timeout_ms, tries)?;
    let lookup = resolver
        .lookup(Name::from(address), RecordType::PTR)
        .await
        .map_err(|e| error(query_error(&e), "getHostByAddr", ip))?;
    let names: Vec<Value> = lookup
        .answers()
        .iter()
        .filter_map(|r| match &r.data {
            RData::PTR(p) => Some(json!(name(&p.0))),
            _ => None,
        })
        .collect();
    Ok(Value::Array(names))
}

/// The servers of the system configuration, for `dns.getServers()`.
pub fn system_servers() -> Value {
    match hickory_resolver::system_conf::read_system_conf() {
        Ok((config, _)) => {
            let mut list: Vec<String> = Vec::new();
            for server in config.name_servers() {
                let ip = server.ip.to_string();
                let port = server.connections.first().map(|c| c.port).unwrap_or(53);
                let entry = if port == 53 {
                    ip
                } else if server.ip.is_ipv6() {
                    format!("[{ip}]:{port}")
                } else {
                    format!("{ip}:{port}")
                };
                if !list.contains(&entry) {
                    list.push(entry);
                }
            }
            json!(list)
        }
        Err(_) => json!([]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn looks_up_localhost_and_ips() {
        let found = lookup("localhost", 0).await.unwrap();
        assert!(found
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["address"] == "127.0.0.1" || a["address"] == "::1"));
        assert_eq!(
            lookup("127.0.0.1", 4).await.unwrap(),
            json!([{ "address": "127.0.0.1", "family": 4 }])
        );
        let missing = lookup("no-such-host.invalid", 0).await.unwrap_err();
        assert_eq!(
            (missing["code"].as_str(), missing["syscall"].as_str()),
            (Some("ENOTFOUND"), Some("getaddrinfo"))
        );
        assert_eq!(syscall("MX"), "queryMx");
        assert_eq!(
            parse_server("[::1]:5353"),
            Some(("::1".parse().unwrap(), 5353))
        );
    }
}
