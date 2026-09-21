use std::borrow::Cow;

use axum::{
    Json,
    body::to_bytes,
    extract::{FromRequest, Request},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

pub const MAX_JSON_BODY_BYTES: usize = 128 * 1024;

pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: Cow<'static, str>,
    request_id: Uuid,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: Cow<'static, str>,
    request_id: Uuid,
}

pub struct SafeJson<T>(pub T);

impl ApiError {
    pub fn bad_request(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
            "valid authentication is required",
        )
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "resource not found")
    }

    pub fn conflict(code: &'static str, message: &'static str) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn precondition_required() -> Self {
        Self::new(
            StatusCode::PRECONDITION_REQUIRED,
            "if_match_required",
            "a quoted If-Match revision is required",
        )
    }

    pub fn stale_revision() -> Self {
        Self::new(
            StatusCode::PRECONDITION_FAILED,
            "stale_revision",
            "the resource revision has changed",
        )
    }

    pub fn database_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "database_unavailable",
            "the durable database dependency is unavailable",
        )
    }

    pub fn foundation_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "foundation_unavailable",
            "the durable control foundation is unavailable",
        )
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "the request could not be completed",
        )
    }

    fn new(status: StatusCode, code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            request_id: Uuid::new_v4(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                    request_id: self.request_id,
                },
            }),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        Self::database_unavailable()
    }
}

impl<S, T> FromRequest<S> for SafeJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let content_type = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !content_type
            .split(';')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
        {
            return Err(ApiError::bad_request(
                "malformed_json",
                "a JSON request body is required",
            ));
        }

        let bytes = to_bytes(request.into_body(), MAX_JSON_BODY_BYTES)
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "the JSON request body exceeds 128 KiB",
                )
            })?;
        serde_json::from_slice(&bytes).map(SafeJson).map_err(|_| {
            ApiError::bad_request(
                "malformed_json",
                "the JSON request body is malformed or contains unknown fields",
            )
        })
    }
}
