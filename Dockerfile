FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY static ./static
ENV DATA_DIR=/data
ENV PORT=8000
EXPOSE 8000
CMD ["python3", "server.py"]
