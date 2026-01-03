from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from urllib.parse import urlparse
import httpx
import json
import logging
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Add CORS middleware to allow client to connect locally
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allow all methods
    allow_headers=["*"],  # Allow all headers
)

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Pydantic models for request validation
class DetailsRequest(BaseModel):
    day: str
    party_size: int
    config_token: str
    restaurant_id: str
    headers: dict
    select_proxy: dict

class ReservationRequest(BaseModel):
    book_token: str
    payment_id: int
    headers: dict
    select_proxy: dict

def format_proxy_url(proxy_url: str) -> str:
    if not urlparse(proxy_url).scheme:
        return f"http://{proxy_url}"
    return proxy_url

@app.get("/")
async def index():
    logger.info("Index route accessed")
    return {"message": "Server is live!"}

@app.post("/api/get-details")
async def get_details(data: DetailsRequest):
    logger.info("Get details endpoint accessed")
    logger.debug(f"Request data: {data}")

    # Format proxy URLs
    formatted_proxies = {}
    if data.select_proxy:
        for scheme, proxy in data.select_proxy.items():
            formatted_proxies[f"{scheme}://"] = format_proxy_url(proxy)
        formatted_proxies['https://'] = formatted_proxies.get('http://', formatted_proxies.get('https://', ''))

    url = f'https://api.resy.com/3/details?day={data.day}&party_size={data.party_size}&x-resy-auth-token={data.headers["X-Resy-Auth-Token"]}&venue_id={data.restaurant_id}&config_id={data.config_token}'
    headers = {
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Authorization': data.headers["Authorization"],
        'Host': 'api.resy.com',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }

    async with httpx.AsyncClient(proxies=formatted_proxies) as client:
        try:
            response = await client.get(url, headers=headers)
            logger.info(f"Get Details API request made to {url} using proxy {formatted_proxies}")
            logger.debug(f"Response status code: {response.status_code}")
            response.raise_for_status()
        except httpx.ProxyError as e:
            logger.error(f"Proxy error: {e}")
            raise HTTPException(status_code=500, detail="Proxy connection failed")
        except httpx.RequestError as e:
            logger.error(f"Request failed: {e}")
            raise HTTPException(status_code=500, detail="Request failed")

    if response.status_code != 200:
        logger.warning(f"Failed to get details for restaurant {data.restaurant_id}. Status code: {response.status_code}")
        raise HTTPException(status_code=response.status_code, detail=f"Failed to get details for restaurant {data.restaurant_id}")

    response_data = response.json()
    logger.info("Details retrieved successfully")
    return {"response_value": response_data['book_token']['value']}

@app.post("/api/book-reservation")
async def book_reservation(data: ReservationRequest):
    logger.info("Book reservation endpoint accessed")
    logger.debug(f"Request data: {data}")

    # Format proxy URLs
    formatted_proxies = {}
    if data.select_proxy:
        for scheme, proxy in data.select_proxy.items():
            formatted_proxies[f"{scheme}://"] = format_proxy_url(proxy)
        formatted_proxies['https://'] = formatted_proxies.get('http://', formatted_proxies.get('https://', ''))

    url = 'https://api.resy.com/3/book'
    payload = {
        'book_token': data.book_token,
        'struct_payment_method': json.dumps({"id": data.payment_id}),
        'source_id': 'resy.com-venue-details',
    }

    headers = {
        'Host': 'api.resy.com',
        'X-Origin': 'https://widgets.resy.com',
        'X-Resy-Auth-Token': data.headers['X-Resy-Auth-Token'],
        'Authorization': data.headers['Authorization'],
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/',
        'X-Resy-Universal-Auth': data.headers['X-Resy-Auth-Token'],
        'Accept': 'application/json, text/plain, */*',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'empty',
        'Referer': 'https://widgets.resy.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
    }

    async with httpx.AsyncClient(proxies=formatted_proxies) as client:
        response = await client.post(url, data=payload, headers=headers)

    logger.info(f"Reservation request made. Status code: {response.status_code} using proxy {formatted_proxies}")
    return JSONResponse(content=response.json(), status_code=response.status_code)

if __name__ == '__main__':
    import uvicorn
    logger.info("Starting FastAPI application")
    uvicorn.run(app, host="0.0.0.0", port=8000)
