# Builds the sample API (Azm.Wopi.SampleHost). In your platform, build your own API image instead;
# it just needs a reference to Azm.Wopi.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish Azm.Wopi.SampleHost/Azm.Wopi.SampleHost.csproj -c Release -o /app /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
RUN mkdir -p /data && chown app:app /data
ENV ASPNETCORE_URLS=http://+:8080 \
    Wopi__StoragePath=/data
VOLUME /data
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "Azm.Wopi.SampleHost.dll"]
