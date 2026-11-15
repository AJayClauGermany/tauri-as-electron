//! Node's `tls` (Cargo feature `node-tls`): rustls (with ring, as
//! tauri-plugin-http uses it) over node_net's TCP sockets.
//!
//! - Client: Mozilla's root store (webpki-roots, as Node bundles), or the
//!   `ca` given; `servername` for SNI and the name check; ALPN; client
//!   certificates. With `rejectUnauthorized: false` the certificate is still
//!   verified and the result recorded (`authorized`, `authorizationError`),
//!   as in Node, but the connection proceeds.
//! - Server: `key` / `cert` (PEM), ALPN, and client certificates with
//!   `requestCert` + `ca`.

use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rustls::{
    client::{
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        WebPkiServerVerifier,
    },
    crypto::{ring, CryptoProvider},
    pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer, ServerName, UnixTime},
    server::WebPkiClientVerifier,
    CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, ServerConfig,
    SignatureScheme,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_rustls::{TlsAcceptor, TlsConnector};

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientOptions {
    pub servername: Option<String>,
    pub reject_unauthorized: Option<bool>,
    /// PEM certificates replacing the default roots.
    pub ca: Vec<String>,
    pub cert: Option<String>,
    pub key: Option<String>,
    #[serde(rename = "ALPNProtocols")]
    pub alpn_protocols: Vec<String>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerOptions {
    pub cert: String,
    pub key: String,
    pub ca: Vec<String>,
    pub request_cert: bool,
    pub reject_unauthorized: Option<bool>,
    #[serde(rename = "ALPNProtocols")]
    pub alpn_protocols: Vec<String>,
}

fn invalid(message: impl Into<String>) -> Value {
    json!({ "code": "ERR_INVALID_ARG_VALUE", "message": message.into() })
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring::default_provider())
}

fn certificates(pem: &str) -> Result<Vec<CertificateDer<'static>>, Value> {
    let list: Result<Vec<_>, _> = CertificateDer::pem_slice_iter(pem.as_bytes()).collect();
    let list = list.map_err(|e| invalid(format!("Invalid certificate PEM: {e}")))?;
    if list.is_empty() {
        return Err(invalid("No certificate found in the PEM data"));
    }
    Ok(list)
}

fn private_key(pem: &str) -> Result<PrivateKeyDer<'static>, Value> {
    PrivateKeyDer::from_pem_slice(pem.as_bytes())
        .map_err(|e| invalid(format!("Invalid private key PEM: {e}")))
}

fn roots(ca: &[String]) -> Result<RootCertStore, Value> {
    let mut store = RootCertStore::empty();
    if ca.is_empty() {
        store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    } else {
        for pem in ca {
            for cert in certificates(pem)? {
                store
                    .add(cert)
                    .map_err(|e| invalid(format!("Invalid CA certificate: {e}")))?;
            }
        }
    }
    Ok(store)
}

/// OpenSSL's names for certificate failures, which Node reports as `code`.
fn certificate_code(error: &rustls::Error) -> &'static str {
    match error {
        rustls::Error::InvalidCertificate(e) => match e {
            CertificateError::Expired | CertificateError::ExpiredContext { .. } => {
                "CERT_HAS_EXPIRED"
            }
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                "CERT_NOT_YET_VALID"
            }
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => {
                "ERR_TLS_CERT_ALTNAME_INVALID"
            }
            CertificateError::Revoked => "CERT_REVOKED",
            CertificateError::BadSignature => "CERT_SIGNATURE_FAILURE",
            CertificateError::UnknownIssuer => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            _ => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        },
        _ => "ECONNRESET",
    }
}

/// Verifies like WebPKI, but with `rejectUnauthorized: false` records the
/// failure instead of failing the handshake.
#[derive(Debug)]
struct RecordingVerifier {
    inner: Arc<WebPkiServerVerifier>,
    reject: bool,
    outcome: Arc<Mutex<Option<(String, String)>>>,
}

impl ServerCertVerifier for RecordingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self
            .inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
        {
            Ok(ok) => Ok(ok),
            Err(error) => {
                *self.outcome.lock().unwrap() =
                    Some((certificate_code(&error).to_string(), error.to_string()));
                if self.reject {
                    Err(error)
                } else {
                    Ok(ServerCertVerified::assertion())
                }
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// What `TLSSocket` reports: protocol, cipher, ALPN and the peer certificate (DER, base64).
fn session_info(
    protocol: Option<rustls::ProtocolVersion>,
    suite: Option<rustls::SupportedCipherSuite>,
    alpn: Option<&[u8]>,
    peer: Option<&[CertificateDer<'_>]>,
) -> Value {
    let protocol = match protocol {
        Some(rustls::ProtocolVersion::TLSv1_3) => "TLSv1.3",
        Some(rustls::ProtocolVersion::TLSv1_2) => "TLSv1.2",
        _ => "unknown",
    };
    let cipher = suite
        .map(|s| format!("{:?}", s.suite()))
        .unwrap_or_default();
    json!({
        "protocol": protocol,
        "cipher": cipher,
        "alpnProtocol": alpn.map(|p| String::from_utf8_lossy(p).into_owned()),
        "peerCertificate": peer.and_then(|chain| chain.first()).map(|c| BASE64.encode(c.as_ref())),
    })
}

/// Connect TLS over `stream` for `host`. Returns the TLS stream and the session info.
pub async fn connect(
    stream: TcpStream,
    host: &str,
    options: &ClientOptions,
) -> Result<(tokio_rustls::client::TlsStream<TcpStream>, Value), Value> {
    let reject = options.reject_unauthorized.unwrap_or(true);
    let roots = Arc::new(roots(&options.ca)?);
    let inner = WebPkiServerVerifier::builder_with_provider(roots, provider())
        .build()
        .map_err(|e| invalid(format!("Invalid CA certificates: {e}")))?;
    let outcome = Arc::new(Mutex::new(None));
    let verifier = Arc::new(RecordingVerifier {
        inner,
        reject,
        outcome: outcome.clone(),
    });
    let builder = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| invalid(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier);
    let mut config = match (&options.cert, &options.key) {
        (Some(cert), Some(key)) => builder
            .with_client_auth_cert(certificates(cert)?, private_key(key)?)
            .map_err(|e| invalid(e.to_string()))?,
        _ => builder.with_no_client_auth(),
    };
    config.alpn_protocols = options
        .alpn_protocols
        .iter()
        .map(|p| p.as_bytes().to_vec())
        .collect();
    let name = options
        .servername
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| host.to_string());
    let server_name = ServerName::try_from(name.clone())
        .map_err(|_| invalid(format!("Invalid servername '{name}'")))?;
    let tls = TlsConnector::from(Arc::new(config)).connect(server_name, stream).await.map_err(|e| {
        let recorded = outcome.lock().unwrap().clone();
        match recorded {
            Some((code, message)) => json!({ "code": code, "message": message, "host": name }),
            None => json!({ "code": "ECONNRESET", "message": format!("Client network socket disconnected before secure TLS connection was established: {e}"), "host": name }),
        }
    })?;
    let (_, connection) = tls.get_ref();
    let mut info = session_info(
        connection.protocol_version(),
        connection.negotiated_cipher_suite(),
        connection.alpn_protocol(),
        connection.peer_certificates(),
    );
    let failure = outcome.lock().unwrap().clone();
    info["authorized"] = json!(failure.is_none());
    info["authorizationError"] = match failure {
        Some((code, _)) => json!(code),
        None => Value::Null,
    };
    info["servername"] = json!(name);
    Ok((tls, info))
}

/// The acceptor for a TLS server.
pub fn acceptor(options: &ServerOptions) -> Result<TlsAcceptor, Value> {
    let builder = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| invalid(e.to_string()))?;
    let builder = if options.request_cert && !options.ca.is_empty() {
        let verifier =
            WebPkiClientVerifier::builder_with_provider(Arc::new(roots(&options.ca)?), provider());
        let verifier = if options.reject_unauthorized.unwrap_or(true) {
            verifier
        } else {
            verifier.allow_unauthenticated()
        };
        builder.with_client_cert_verifier(verifier.build().map_err(|e| invalid(e.to_string()))?)
    } else {
        builder.with_no_client_auth()
    };
    let mut config = builder
        .with_single_cert(certificates(&options.cert)?, private_key(&options.key)?)
        .map_err(|e| invalid(format!("Invalid key or certificate: {e}")))?;
    config.alpn_protocols = options
        .alpn_protocols
        .iter()
        .map(|p| p.as_bytes().to_vec())
        .collect();
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Session info of an accepted connection.
pub fn server_info(tls: &tokio_rustls::server::TlsStream<TcpStream>) -> Value {
    let (_, connection) = tls.get_ref();
    let peer = connection.peer_certificates();
    let mut info = session_info(
        connection.protocol_version(),
        connection.negotiated_cipher_suite(),
        connection.alpn_protocol(),
        peer,
    );
    info["authorized"] = json!(peer.is_some());
    info["authorizationError"] = if peer.is_some() {
        Value::Null
    } else {
        json!("UNABLE_TO_GET_ISSUER_CERT")
    };
    info["servername"] = json!(connection.server_name());
    info
}
