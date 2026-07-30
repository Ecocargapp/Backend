# AgroSoft — Backend

API del sistema de gestión integrada de planta de concentrados y granjas porcinas.
Node.js + Express + PostgreSQL.

## Estado actual (Etapa 1)
Autenticación y módulo administrativo de usuarios:
- Login con contraseñas cifradas (bcrypt) y sesiones por token (JWT, 8 h)
- Gestión de usuarios (crear, activar/desactivar, restablecer contraseña)
- Roles admin / operador
- Esquema de base de datos listo para planta, granjas e inventario

---

## Requisitos
- Node.js 18 o superior
- PostgreSQL 14 o superior

## Instalación local

1. Instalar dependencias:
   ```
   npm install
   ```

2. Copiar la plantilla de configuración y rellenarla:
   ```
   cp .env.example .env
   ```
   Edita `.env` con tus datos reales (ver sección Variables más abajo).

3. Crear las tablas y el usuario administrador:
   ```
   npm run init-db
   ```

4. Arrancar:
   ```
   npm start
   ```

El API queda en `http://localhost:3000`. Prueba `http://localhost:3000/api/salud`.

---

## Variables de entorno (.env)

| Variable      | Descripción                                             |
|---------------|---------------------------------------------------------|
| PORT          | Puerto del servidor (por defecto 3000)                  |
| JWT_SECRET    | Clave para firmar sesiones. Larga y aleatoria.          |
| DB_HOST       | Host de PostgreSQL (localhost si está en la misma máquina) |
| DB_PORT       | Puerto de PostgreSQL (5432)                             |
| DB_USER       | Usuario de la base de datos                             |
| DB_PASSWORD   | Contraseña de la base de datos                          |
| DB_NAME       | Nombre de la base de datos                              |
| DB_SSL        | `true` solo si usas Amazon RDS u otro Postgres con SSL  |
| FRONTEND_URL  | URL(s) del frontend autorizadas para CORS (separadas por coma) |

Genera una JWT_SECRET así:
```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Despliegue en el servidor EC2 (resumen)

1. Instalar PostgreSQL en el servidor:
   ```
   sudo apt update && sudo apt install postgresql -y
   ```

2. Crear la base de datos y el usuario:
   ```
   sudo -u postgres psql
   CREATE DATABASE agrosoft;
   CREATE USER agrosoft WITH ENCRYPTED PASSWORD 'una-clave-fuerte';
   GRANT ALL PRIVILEGES ON DATABASE agrosoft TO agrosoft;
   \q
   ```

3. Clonar el repositorio, instalar Node y dependencias, crear el `.env`,
   correr `npm run init-db` y levantar el servicio.

4. Para que el backend siga corriendo tras cerrar la sesión SSH, usar un
   gestor de procesos como `pm2`:
   ```
   sudo npm install -g pm2
   pm2 start server.js --name agrosoft-api
   pm2 save
   ```

La guía detallada paso a paso se entrega aparte.

---

## Seguridad
- El archivo `.env` NUNCA se sube a Git (está en `.gitignore`).
- Las contraseñas se guardan solo cifradas, nunca en texto plano.
- En producción, servir el API detrás de HTTPS (mismo Nginx + Certbot del sitio web).

## Próximas etapas
2. Catálogo (items y ubicaciones)  ·  3. Producción en planta  ·
4. Despacho y consumo en granjas  ·  5. Inventario y reportes

---

## Módulo de Granja de Cría (Etapa 2)

Control del ciclo reproductivo porcino con manejo individual por cerda.

### Inicializar sus tablas
Tras `npm run init-db`, ejecutar también:  `node initdb_cria.js`
Crea las tablas (cerdas, servicios, diagnósticos, partos, destetes, salidas)
y carga las razas base (Camborough, Franpabel).

### Ciclo automatizado
Cada evento actualiza el estado de la cerda: servicio → servida ·
diagnóstico + → gestante · parto → lactante · destete → vacía.
La fecha probable de parto se calcula a 114 días del servicio.
